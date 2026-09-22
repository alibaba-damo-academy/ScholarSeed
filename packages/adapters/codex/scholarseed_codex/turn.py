"""Single-owner native turn submission, projection and recovery reconciliation."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Mapping, Protocol

from scholarseed_codex.activity import (
    auto_approval_payload,
    collaboration_activity_payload,
    collaboration_receivers,
    command_name,
    native_activity_payload,
    search_payload,
    skill_activity_payload,
    skill_for_command,
)
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.failure import (
    ProviderFailure,
    authentication_failure,
    provider_failure,
    unpack_error,
)
from scholarseed_codex.files import observed_changes, workspace_relative_path
from scholarseed_codex.history import (
    replace_turn_snapshot,
    resume_turn_snapshots,
    terminal_turn_status,
)
from scholarseed_codex.input import serialize_input, skill_inputs, start_parameters
from scholarseed_codex.protocol.constants import MCP_TOOL_NAME_PREFIX
from scholarseed_codex.protocol.mcp import JsonValue
from scholarseed_codex.protocol.session import (
    CodexSessionEventKind,
    CodexSessionEventObserver,
    CodexSessionOpenRequest,
    CodexTurnResult,
    CodexUsage,
)
from scholarseed_codex.protocol.state import (
    CODEX_AUTO_APPROVAL_NOTIFICATION_KINDS,
    CODEX_BENIGN_NOTIFICATION_METHODS,
    CODEX_COLLAB_TOOL_CALL_ITEM_TYPE,
    CODEX_DEDICATED_ITEM_TYPES,
    CODEX_PROVIDER_INCIDENT_METHODS,
    CODEX_SEARCH_NOTIFICATION_KINDS,
    CODEX_WEB_SEARCH_ITEM_TYPE,
    AppServerError,
    _message_phase,
    _resolved_history_message_phase,
    logger,
)
from scholarseed_codex.router import ThreadRouter
from scholarseed_codex.watch import WorkspaceWatch
from scholarseed_runtime.contract.history import (
    MessagePhase,
    ResumeTurnSnapshot,
    TurnStatus,
)
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import TurnInput


class ThreadContext(Protocol):
    thread_id: str
    request: CodexSessionOpenRequest
    listener: CodexSessionEventObserver | None
    model: str
    writable_roots: tuple[str, ...]
    attached_generation: int


class TurnRequest(Protocol):
    async def __call__(self, method: str, params: Any, *, generation: int) -> dict[str, Any]: ...


class CodexTurnRuntime:
    """Own one thread's mutable turn state across normal and recovered delivery."""

    def __init__(
        self,
        thread: ThreadContext,
        *,
        request: TurnRequest,
        ensure_attached: Callable[[str], Awaitable[int]],
        stale_requests: Callable[[str, str, str], Awaitable[None]],
        emitter: CodexEmitter,
        router: ThreadRouter,
        watcher: WorkspaceWatch,
        diagnostic: Callable[[str], None],
        protocol_error: Callable[[str], None],
        resume_turns: tuple[ResumeTurnSnapshot, ...] = (),
    ) -> None:
        self._thread = thread
        self._request = request
        self._ensure_attached = ensure_attached
        self._stale_requests = stale_requests
        self._emitter = emitter
        self._router = router
        self._watcher = watcher
        self._diagnostic = diagnostic
        self._protocol_error = protocol_error
        self._generation = thread.attached_generation
        self._closed = False
        self._settled_turns: set[str] = set()
        self._completion_lock = asyncio.Lock()
        self.resume_turns = resume_turns
        self.active_turn_id: str = ""
        self.active_turn_client_id: str = ""
        self.turn_client_ids: dict[str, str] = dict()
        self.interrupted_turn_id: str = ""
        self.interrupted_turn_client_id: str = ""
        self.interrupted_turn_generation: int = 0
        self.turn_done: asyncio.Future[dict[str, Any]] | None = None
        self.final_text: str = ""
        self.usage: CodexUsage = CodexUsage()
        self.item_names: dict[str, str] = dict()
        self.item_output: dict[str, str] = dict()
        self.item_details: dict[str, Mapping[str, Any]] = dict()
        self.message_phases: dict[str, MessagePhase] = dict()
        self.pending_message_deltas: dict[str, list[str]] = dict()
        self.pending_unknown_messages: dict[str, tuple[str, str]] = dict()
        self.active_skill_inputs: dict[str, str] = dict()
        self.skill_items: dict[str, tuple[str, str]] = dict()
        self.turn_items: dict[str, set[str]] = dict()
        self.streamed_messages: set[str] = set()
        self.fs_watch_id: str = ""
        self.watched_paths: dict[str, str] = dict()
        self.explicit_file_paths: set[str] = set()
        self.ambiguous_submission_id: str = ""
        self.ambiguous_incident_id: str = ""
        self.ambiguous_generation: int = 0
        self.provider_incident_id: str = ""
        self.provider_incident_turn_id: str = ""
        self.provider_incident_kind: RuntimeIncidentKind = RuntimeIncidentKind.PROVIDER_RETRY
        self.provider_failure: ProviderFailure | None = None

    @property
    def thread_id(self) -> str:
        return self._thread.thread_id

    @property
    def request(self) -> CodexSessionOpenRequest:
        return self._thread.request

    @property
    def attached_generation(self) -> int:
        return self._thread.attached_generation

    async def reconcile(self, thread: Mapping[str, Any], generation: int) -> None:
        self._generation = generation
        self.resume_turns = resume_turn_snapshots(thread)
        await self._reconcile_interrupted_from_thread(thread, generation)
        await self._reconcile_ambiguous_from_thread(thread)

    def abandon_files(self) -> None:
        self._watcher.abandon_turn(self.thread_id)
        self.watched_paths.clear()
        self.explicit_file_paths.clear()

    def callback_context(self, turn_id: str, item_id: str) -> Mapping[str, Any]:
        if turn_id and item_id:
            self.turn_items.setdefault(turn_id, set()).add(item_id)
        return self.item_details.get(item_id, {})

    async def close(self, generation: int, connected: bool) -> None:
        self._closed = True
        self.abandon_files()
        if self.active_turn_id and self.attached_generation == generation and connected:
            try:
                await self._request(
                    "turn/interrupt",
                    {"threadId": self.thread_id, "turnId": self.active_turn_id},
                    generation=generation,
                )
            except Exception:
                logger.exception("failed to interrupt Codex thread during close")
        await self._stale_requests(self.thread_id, "", "thread_closed")
        if self.turn_done is not None and not self.turn_done.done():
            self.turn_done.cancel()

    async def notification(
        self, method: str, params: Mapping[str, Any], *, generation: int
    ) -> None:
        self._generation = generation
        message_generation = generation
        raw_turn = params.get("turn")
        nested_turn = dict(raw_turn) if isinstance(raw_turn, Mapping) else {}
        turn_id = str(params.get("turnId") or nested_turn.get("id") or "")
        item_id = str(params.get("itemId") or "")
        thread_id = self._thread.thread_id
        if turn_id and turn_id in self._settled_turns:
            self._diagnostic(f"suppressed_settled_turn_projection:{method}")
            return
        if self.interrupted_turn_id and turn_id == self.interrupted_turn_id:
            if method == "turn/completed":
                terminal_status = terminal_turn_status(str(nested_turn.get("status") or ""))
                if terminal_status is not None:
                    await self._resolve_interrupted_turn(
                        turn_id,
                        terminal_status,
                        message_generation,
                        source="turn_completed",
                    )
                return
            self._diagnostic(f"suppressed_interrupted_turn_projection:{method}")
            return
        if turn_id:
            self._router.bind_turn(turn_id, thread_id)
        if item_id:
            self._router.bind_item(item_id, thread_id)
            if turn_id:
                self.turn_items.setdefault(turn_id, set()).add(item_id)
        if method not in CODEX_PROVIDER_INCIDENT_METHODS:
            await self._settle_provider_retry(turn_id, message_generation)
        if method == "turn/started":
            turn = dict(params.get("turn") or {})
            turn_id = str(turn.get("id") or turn_id)
            self.active_turn_id = turn_id
            client_id = str(
                turn.get("clientId")
                or turn.get("clientUserMessageId")
                or self.active_turn_client_id
            )
            if turn_id and client_id:
                self.turn_client_ids[turn_id] = client_id
            if turn_id:
                self._router.bind_turn(turn_id, thread_id)
            resolved_ambiguous_incident_id = ""
            if self.ambiguous_generation == message_generation:
                resolved_ambiguous_incident_id = self.ambiguous_incident_id
                self.ambiguous_submission_id = ""
                self.ambiguous_incident_id = ""
                self.ambiguous_generation = 0
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.TURN_STARTED,
                turn_id=turn_id,
                payload={
                    "process_generation": message_generation,
                    "resolved_ambiguous_incident_id": resolved_ambiguous_incident_id,
                },
            )
            return
        if method == "item/agentMessage/delta":
            text = str(params.get("delta") or "")
            phase = self.message_phases.get(item_id)
            if phase is None and item_id:
                self.pending_message_deltas.setdefault(item_id, []).append(text)
            self.streamed_messages.add(item_id)
            payload: dict[str, JsonValue] = {"text": text}
            if phase is not None:
                payload["phase"] = phase.value
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.ASSISTANT_DELTA,
                turn_id=turn_id,
                item_id=item_id,
                payload=payload,
            )
            return
        if method == "item/reasoning/summaryTextDelta":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.REASONING_DELTA,
                turn_id=turn_id,
                item_id=item_id,
                payload={"text": str(params.get("delta") or "")},
            )
            return
        if method == "item/reasoning/textDelta":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.REASONING_DELTA,
                turn_id=turn_id,
                item_id=item_id,
                payload={
                    "text": str(params.get("delta") or ""),
                    "content_index": int(params.get("contentIndex", 0) or 0),
                },
            )
            return
        if method == "item/reasoning/summaryPartAdded":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.REASONING_DELTA,
                turn_id=turn_id,
                item_id=item_id,
                payload={
                    "text": "",
                    "summary_part_added": True,
                    "summary_index": int(params.get("summaryIndex", 0) or 0),
                },
            )
            return
        if method == "item/commandExecution/outputDelta":
            delta = str(params.get("delta") or "")
            self.item_output[item_id] = self.item_output.get(item_id, "") + delta
            if item_id in self.skill_items:
                return
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.TOOL_PROGRESS,
                turn_id=turn_id,
                item_id=item_id,
                payload={"output": delta},
            )
            return
        if method == "item/commandExecution/terminalInteraction":
            if item_id in self.skill_items:
                return
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.TOOL_PROGRESS,
                turn_id=turn_id,
                item_id=item_id,
                payload={
                    "output": str(params.get("stdin") or params.get("text") or ""),
                    "source": "terminal_interaction",
                },
            )
            return
        if method == "item/mcpToolCall/progress":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.TOOL_PROGRESS,
                turn_id=turn_id,
                item_id=item_id,
                payload={"output": str(params.get("message") or ""), "source": "mcp"},
            )
            return
        if method == "item/fileChange/outputDelta":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.TOOL_PROGRESS,
                turn_id=turn_id,
                item_id=item_id,
                payload={"output": str(params.get("delta") or ""), "source": "file_change"},
            )
            return
        if method == "item/fileChange/patchUpdated":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.DIFF_UPDATED,
                turn_id=turn_id,
                item_id=item_id,
                payload={"changes": list(params.get("changes") or [])},
            )
            return
        if method == "item/started":
            await self._item_started(turn_id, dict(params.get("item") or {}))
            return
        if method == "item/completed":
            await self._item_completed(turn_id, dict(params.get("item") or {}))
            return
        if method == "turn/plan/updated":
            plan = [
                {
                    "content": str(row.get("step") or ""),
                    "status": {
                        "inProgress": "in_progress",
                        "completed": "completed",
                    }.get(str(row.get("status") or ""), "pending"),
                }
                for row in list(params.get("plan") or [])
            ]
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.PLAN_UPDATED,
                turn_id=turn_id,
                payload={
                    "todos": plan,
                    "explanation": str(params.get("explanation") or ""),
                },
            )
            return
        if method == "item/plan/delta":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.PLAN_DELTA,
                turn_id=turn_id,
                item_id=item_id,
                payload={"delta": str(params.get("delta") or "")},
            )
            return
        if method == "turn/diff/updated":
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.DIFF_UPDATED,
                turn_id=turn_id,
                payload={"diff": str(params.get("diff") or "")},
            )
            return
        if method in {"warning", "guardianWarning"}:
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.RUNTIME_WARNING,
                payload={"message": str(params.get("message") or "")},
            )
            return
        auto_approval_kind = CODEX_AUTO_APPROVAL_NOTIFICATION_KINDS.get(method)
        if auto_approval_kind is not None:
            completed = auto_approval_kind is CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED
            await self._emitter.emit(
                self._thread,
                auto_approval_kind,
                turn_id=turn_id,
                item_id=str(params.get("reviewId") or item_id),
                payload=auto_approval_payload(params, completed=completed),
            )
            return
        if method == "thread/tokenUsage/updated":
            token_usage = dict(params.get("tokenUsage") or {})
            last = dict(token_usage.get("last") or {})
            self.usage = CodexUsage(
                input_tokens=int(last.get("inputTokens", 0) or 0),
                output_tokens=int(last.get("outputTokens", 0) or 0),
                cache_read_tokens=int(last.get("cachedInputTokens", 0) or 0),
                cache_creation_tokens=int(last.get("cacheWriteInputTokens", 0) or 0),
            )
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.USAGE_UPDATED,
                payload={
                    "input_tokens": self.usage.input_tokens,
                    "output_tokens": self.usage.output_tokens,
                    "cache_read_tokens": self.usage.cache_read_tokens,
                    "cache_creation_tokens": self.usage.cache_creation_tokens,
                    "context_window": int(token_usage.get("modelContextWindow", 0) or 0),
                },
            )
            return
        if method == "thread/compacted":
            await self._emitter.emit(self._thread, CodexSessionEventKind.CONTEXT_COMPACTED)
            return
        if method == "error":
            will_retry = bool(params.get("willRetry"))
            failure = provider_failure(params.get("error"))
            logger.info(
                "codex_provider_error thread_id=%s turn_id=%s code=%s http_status=%s will_retry=%s",
                self._thread.thread_id,
                turn_id or self.active_turn_id,
                failure.diagnostic_code,
                failure.http_status,
                will_retry,
            )
            self.provider_failure = failure
            incident_turn_id = turn_id or self.active_turn_id
            if not self.provider_incident_id or self.provider_incident_turn_id != incident_turn_id:
                self.provider_incident_id = uuid.uuid4().hex
                self.provider_incident_turn_id = incident_turn_id
            self.provider_incident_kind = (
                RuntimeIncidentKind.PROVIDER_RETRY
                if will_retry
                else (
                    RuntimeIncidentKind.AUTHENTICATION_REQUIRED
                    if authentication_failure(failure)
                    else RuntimeIncidentKind.RPC_REJECTED
                )
            )
            incident = RuntimeIncident(
                incident_id=self.provider_incident_id,
                scope=(RuntimeIncidentScope.PROVIDER if will_retry else RuntimeIncidentScope.TURN),
                state=(
                    RuntimeIncidentState.RETRYING if will_retry else RuntimeIncidentState.DETECTED
                ),
                kind=self.provider_incident_kind,
                strategy=(
                    RuntimeRecoveryStrategy.VENDOR_RETRY
                    if will_retry
                    else RuntimeRecoveryStrategy.NONE
                ),
                retryability=(
                    RuntimeRetryability.IN_PROGRESS if will_retry else failure.retryability
                ),
                safe_error=failure.message,
                process_generation=message_generation,
                vendor_thread_id=self._thread.thread_id,
                vendor_turn_id=incident_turn_id,
                provider_error_code=failure.diagnostic_code,
                provider_http_status=failure.http_status,
            )
            await self._emitter.incident(self._thread, incident, turn_id=incident_turn_id)
            return
        if method == "thread/realtime/error":
            incident = RuntimeIncident(
                incident_id=uuid.uuid4().hex,
                scope=RuntimeIncidentScope.THREAD,
                state=RuntimeIncidentState.FAILED,
                kind=RuntimeIncidentKind.RPC_REJECTED,
                strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                retryability=RuntimeRetryability.USER_RETRYABLE,
                safe_error="codex_realtime_error",
                process_generation=message_generation,
                vendor_thread_id=self._thread.thread_id,
                vendor_turn_id=turn_id,
            )
            await self._emitter.incident(self._thread, incident, turn_id=turn_id)
            return
        if method == "turn/completed":
            await self._turn_completed(dict(params.get("turn") or {}))
            return
        search_kind = CODEX_SEARCH_NOTIFICATION_KINDS.get(method)
        if search_kind is not None:
            await self._emitter.emit(
                self._thread,
                search_kind,
                turn_id=turn_id,
                item_id=str(params.get("callId") or item_id),
                payload=search_payload(params),
            )
            return
        if method in CODEX_BENIGN_NOTIFICATION_METHODS:
            self._diagnostic(f"benign:{method}")
            return
        self._diagnostic(f"unsupported_notification:{method}")
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.RUNTIME_WARNING,
            turn_id=turn_id,
            item_id=item_id,
            payload={"reason": "unsupported_notification", "rpc_method": method},
        )

    async def _reconcile_interrupted_from_thread(
        self,
        thread: Mapping[str, Any],
        generation: int,
    ) -> None:
        """Fence a pre-crash turn until resumed history reports its terminal self._thread."""

        interrupted_turn_id = self.interrupted_turn_id
        if not interrupted_turn_id:
            return
        matched: Mapping[str, Any] | None = None
        for raw_turn in list(thread.get("turns") or []):
            if (
                isinstance(raw_turn, Mapping)
                and str(raw_turn.get("id") or "") == interrupted_turn_id
            ):
                matched = raw_turn
                break
        if matched is None:
            raise AppServerError(
                "Resumed Codex history did not contain the interrupted turn",
                safe_error="codex_interrupted_turn_missing_from_resume",
                generation=generation,
                retryability=RuntimeRetryability.USER_RETRYABLE,
            )
        terminal_status = terminal_turn_status(str(matched.get("status") or ""))
        if terminal_status is not None:
            await self._resolve_interrupted_turn(
                interrupted_turn_id,
                terminal_status,
                generation,
                source="thread_resume",
            )
            return
        if str(matched.get("status") or "") != "inProgress":
            raise AppServerError(
                "Resumed Codex history returned an unknown interrupted-turn status",
                safe_error="codex_interrupted_turn_status_unknown",
                generation=generation,
                retryability=RuntimeRetryability.USER_RETRYABLE,
            )
        self._router.bind_turn(interrupted_turn_id, self._thread.thread_id)
        await self._request(
            "turn/interrupt",
            {"threadId": self._thread.thread_id, "turnId": interrupted_turn_id},
            generation=generation,
        )
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.RUNTIME_STATUS,
            turn_id=interrupted_turn_id,
            payload={
                "status": "interrupted_turn_reconciling",
                "process_generation": generation,
                "client_user_message_id": self.interrupted_turn_client_id,
                "interrupt_sent": True,
            },
        )

    async def _resolve_interrupted_turn(
        self,
        turn_id: str,
        status: TurnStatus,
        generation: int,
        *,
        source: str,
    ) -> None:
        self.abandon_files()
        client_id = self.interrupted_turn_client_id or self.turn_client_ids.get(turn_id, "")
        self.resume_turns = replace_turn_snapshot(
            self.resume_turns,
            ResumeTurnSnapshot(client_id, turn_id, status),
        )
        self.interrupted_turn_id = ""
        self.interrupted_turn_client_id = ""
        self.interrupted_turn_generation = 0
        if self.active_turn_id == turn_id:
            self.active_turn_id = ""
            self.active_turn_client_id = ""
        self._router.forget_turn(turn_id)
        for item_id in self.turn_items.pop(turn_id, set()):
            self._router.forget_item(item_id)
        self.active_skill_inputs.clear()
        self.skill_items.clear()
        self.turn_client_ids.pop(turn_id, None)
        resolved_ambiguous_incident_id = ""
        if client_id and client_id == self.ambiguous_submission_id:
            resolved_ambiguous_incident_id = self.ambiguous_incident_id
            self.ambiguous_submission_id = ""
            self.ambiguous_incident_id = ""
            self.ambiguous_generation = 0
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.RUNTIME_STATUS,
            turn_id=turn_id,
            payload={
                "status": "interrupted_turn_reconciled",
                "terminal_status": status.value,
                "process_generation": generation,
                "client_user_message_id": client_id,
                "source": source,
                "resolved_ambiguous_incident_id": resolved_ambiguous_incident_id,
            },
        )
        self._settled_turns.add(turn_id)

    async def _reconcile_ambiguous_from_thread(
        self,
        thread: Mapping[str, Any],
    ) -> None:
        """Resolve an ambiguous write only from authoritative resumed turn history."""

        submission_id = self.ambiguous_submission_id
        if not submission_id or not self.ambiguous_incident_id:
            return
        matched: Mapping[str, Any] | None = None
        for raw_turn in list(thread.get("turns") or []):
            if not isinstance(raw_turn, Mapping):
                continue
            for raw_item in list(raw_turn.get("items") or []):
                if not isinstance(raw_item, Mapping):
                    continue
                if (
                    str(raw_item.get("type") or "") == "userMessage"
                    and str(raw_item.get("clientId") or "") == submission_id
                ):
                    matched = raw_turn
                    break
            if matched is not None:
                break
        if matched is None:
            return
        turn_id = str(matched.get("id") or "")
        if not turn_id:
            return
        status = str(matched.get("status") or "")
        self.active_turn_id = turn_id
        self._router.bind_turn(turn_id, self._thread.thread_id)
        if status == "inProgress":
            if self.turn_done is None or self.turn_done.done():
                self.turn_done = asyncio.get_running_loop().create_future()
            return
        if status not in {
            TurnStatus.COMPLETED.value,
            TurnStatus.FAILED.value,
            TurnStatus.INTERRUPTED.value,
        }:
            return
        matched_items = list(matched.get("items") or [])
        agent_indexes = [
            index
            for index, item in enumerate(matched_items)
            if isinstance(item, Mapping)
            and str(item.get("type") or "") == "agentMessage"
            and str(item.get("text") or "")
        ]
        final_agent_index = agent_indexes[-1] if agent_indexes else None
        for index, raw_item in enumerate(matched_items):
            if not isinstance(raw_item, Mapping):
                continue
            if str(raw_item.get("type") or "") != "agentMessage":
                continue
            item_id = str(raw_item.get("id") or "")
            text = str(raw_item.get("text") or "")
            phase = _resolved_history_message_phase(
                raw_item.get("phase"),
                item_index=index,
                final_agent_index=final_agent_index,
                turn_status=status,
            )
            if not text:
                continue
            if phase == MessagePhase.FINAL_ANSWER:
                self.final_text = text
            if item_id not in self.streamed_messages:
                self.streamed_messages.add(item_id)
                payload: dict[str, JsonValue] = {"text": text, "reconciled": True}
                if phase is not None:
                    payload["phase"] = phase.value
                await self._emitter.emit(
                    self._thread,
                    CodexSessionEventKind.ASSISTANT_DELTA,
                    turn_id=turn_id,
                    item_id=item_id,
                    payload=payload,
                )
            # A streamed prefix is not completion evidence. Recovered authoritative
            # text must reach the same declaration path as item/completed.
            await self._complete_assistant_message(turn_id, item_id, text, phase)
        await self._turn_completed(matched)

    async def start(self, turn_input: TurnInput) -> CodexTurnResult:
        thread_id = self._thread.thread_id
        if self._closed:
            raise AppServerError("Codex thread is closed", safe_error="codex_thread_closed")
        if self.interrupted_turn_id:
            raise AppServerError(
                f"Codex thread is reconciling an interrupted vendor turn: {thread_id}",
                safe_error="codex_interrupted_turn_reconciling",
                generation=self.interrupted_turn_generation,
                retryability=RuntimeRetryability.IN_PROGRESS,
            )
        self._generation = await self._ensure_attached(thread_id)
        generation = self._generation
        if self.ambiguous_incident_id:
            raise AppServerError(
                f"Codex thread has an unresolved turn submission: {thread_id}",
                safe_error="codex_turn_outcome_unknown",
                generation=self.ambiguous_generation,
                retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
            )
        if self.turn_done is not None and not self.turn_done.done():
            raise AppServerError(f"Codex thread already has an active turn: {thread_id}")
        params = start_parameters(
            thread_id,
            turn_input,
            self._thread.request,
            self._thread.writable_roots,
            self._thread.model,
        )
        self.final_text = ""
        self.usage = CodexUsage()
        self.item_names.clear()
        self.item_output.clear()
        self.item_details.clear()
        self.message_phases.clear()
        self.pending_message_deltas.clear()
        self.pending_unknown_messages.clear()
        self.active_skill_inputs = skill_inputs(turn_input)
        self.skill_items.clear()
        self.streamed_messages.clear()
        self.watched_paths.clear()
        self.explicit_file_paths.clear()
        self.turn_done = asyncio.get_running_loop().create_future()
        completion = self.turn_done
        try:
            await self._watcher.begin_turn(self)
            if self._closed or completion.done() or self.attached_generation != generation:
                raise AppServerError(
                    "Codex attachment changed before turn submission",
                    safe_error="codex_turn_not_submitted",
                    generation=generation,
                    retryability=RuntimeRetryability.USER_RETRYABLE,
                )
        except BaseException:
            self.turn_done = None
            self.abandon_files()
            raise
        submission_id = turn_input.client_user_message_id or uuid.uuid4().hex
        params["clientUserMessageId"] = submission_id
        self.active_turn_client_id = submission_id
        try:
            response = await self._request("turn/start", params, generation=generation)
        except AppServerError as exc:
            if exc.retryability == RuntimeRetryability.UNKNOWN_OUTCOME:
                incident = RuntimeIncident(
                    incident_id=uuid.uuid4().hex,
                    scope=RuntimeIncidentScope.TURN,
                    state=RuntimeIncidentState.FAILED,
                    kind=(
                        RuntimeIncidentKind.RPC_TIMEOUT
                        if exc.safe_error == "runtime_rpc_timeout"
                        else RuntimeIncidentKind.TRANSPORT_LOST
                    ),
                    strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                    safe_error=exc.safe_error,
                    process_generation=exc.generation,
                    vendor_thread_id=thread_id,
                    vendor_turn_id=submission_id,
                    rpc_method="turn/start",
                    rpc_latency_ms=exc.rpc_latency_ms,
                    ambiguous_commit=True,
                )
                self.ambiguous_submission_id = submission_id
                self.ambiguous_incident_id = incident.incident_id
                self.ambiguous_generation = exc.generation
                await self._emitter.emit(
                    self._thread,
                    CodexSessionEventKind.TURN_UNKNOWN,
                    turn_id=submission_id,
                    payload={"safe_error": exc.safe_error},
                    incident=incident,
                )
            else:
                self.abandon_files()
                self.turn_done = None
                self.active_turn_client_id = ""
                self.active_skill_inputs.clear()
            raise
        turn = dict(response.get("turn") or {})
        turn_id = str(turn.get("id") or self.active_turn_id)
        if not turn_id:
            raise AppServerError("Codex App Server returned no turn id")
        if not completion.done():
            self.active_turn_id = turn_id
            self.turn_client_ids[turn_id] = submission_id
            self._router.bind_turn(turn_id, thread_id)
        try:
            completed = await asyncio.wait_for(
                asyncio.shield(completion),
                timeout=self._thread.request.timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            await self.interrupt()
            raise AppServerError(
                f"Codex App Server turn timed out after {self._thread.request.timeout_seconds:g}s"
            ) from exc
        if completed.get("status") == "unknown":
            raise AppServerError(
                "Codex turn outcome is unknown after process exit",
                safe_error="codex_turn_outcome_unknown",
                retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                generation=self.interrupted_turn_generation,
            )
        status = self._turn_status(str(completed.get("status") or "failed"))
        error = (
            provider_failure(completed.get("error")).message if status == TurnStatus.FAILED else ""
        )
        return CodexTurnResult(
            turn_id=str(completed.get("id") or turn_id),
            status=status,
            final_text=self.final_text,
            error=error,
            usage=self.usage,
        )

    @staticmethod
    def _turn_status(status: str) -> TurnStatus:
        if status == TurnStatus.COMPLETED.value:
            return TurnStatus.COMPLETED
        if status in {"interrupted", "cancelled"}:
            return TurnStatus.INTERRUPTED
        return TurnStatus.FAILED

    @staticmethod
    def _turn_error(value: Any) -> tuple[str, str]:
        """Preserve a provider failure without exposing its transport envelope."""

        return unpack_error(value)

    async def steer(self, turn_input: TurnInput) -> str:
        """Append typed user input to the currently active turn with an exact-turn precondition."""

        thread_id = self._thread.thread_id
        self._generation = await self._ensure_attached(thread_id)
        turn_id = self.active_turn_id
        if not turn_id or self.turn_done is None or self.turn_done.done():
            raise AppServerError(f"Codex thread has no active turn to steer: {thread_id}")
        params: dict[str, Any] = {
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": serialize_input(turn_input, self._thread.request.cwd),
        }
        previous_skill_inputs = dict(self.active_skill_inputs)
        self.active_skill_inputs.update(skill_inputs(turn_input))
        submission_id = turn_input.client_user_message_id or uuid.uuid4().hex
        params["clientUserMessageId"] = submission_id
        try:
            response = await self._request("turn/steer", params, generation=self._generation)
        except AppServerError as exc:
            if exc.retryability == RuntimeRetryability.UNKNOWN_OUTCOME:
                await self._emitter.incident(
                    self._thread,
                    RuntimeIncident(
                        incident_id=uuid.uuid4().hex,
                        scope=RuntimeIncidentScope.TURN,
                        state=RuntimeIncidentState.FAILED,
                        kind=(
                            RuntimeIncidentKind.RPC_TIMEOUT
                            if exc.safe_error == "runtime_rpc_timeout"
                            else RuntimeIncidentKind.TRANSPORT_LOST
                        ),
                        strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                        retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                        safe_error=exc.safe_error,
                        process_generation=exc.generation,
                        vendor_thread_id=thread_id,
                        vendor_turn_id=turn_id,
                        rpc_method="turn/steer",
                        rpc_latency_ms=exc.rpc_latency_ms,
                        ambiguous_commit=True,
                    ),
                    turn_id=turn_id,
                    item_id=submission_id,
                )
            else:
                self.active_skill_inputs = previous_skill_inputs
            raise
        response_turn_id = str(response.get("turnId") or turn_id)
        if response_turn_id != turn_id:
            raise AppServerError("Codex App Server steered a different active turn")
        return turn_id

    async def interrupt(self) -> None:
        thread_id = self._thread.thread_id
        self._generation = await self._ensure_attached(thread_id)
        if not self.active_turn_id:
            return
        turn_id = self.active_turn_id
        await self._request(
            "turn/interrupt",
            {"threadId": thread_id, "turnId": turn_id},
            generation=self._generation,
        )
        await self._stale_requests(thread_id, turn_id, "turn_interrupted")

    async def _emit_assistant_message(
        self,
        turn_id: str,
        item_id: str,
        text: str,
        phase: MessagePhase | None,
    ) -> None:
        payload: dict[str, JsonValue] = {"text": text}
        if phase is not None:
            payload["phase"] = phase.value
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.ASSISTANT_DELTA,
            turn_id=turn_id,
            item_id=item_id,
            payload=payload,
        )
        self.streamed_messages.add(item_id)
        if phase != MessagePhase.COMMENTARY:
            self.final_text = text

    async def _flush_unknown_message(
        self,
        turn_id: str,
        phase: MessagePhase,
    ) -> None:
        pending = self.pending_unknown_messages.pop(turn_id, None)
        if pending is None:
            return
        item_id, text = pending
        if item_id not in self.streamed_messages:
            await self._emit_assistant_message(turn_id, item_id, text, phase)
        elif phase == MessagePhase.FINAL_ANSWER:
            self.final_text = text
        await self._complete_assistant_message(turn_id, item_id, text, phase)

    async def _flush_pending_message_deltas(
        self,
        turn_id: str,
        item_id: str,
        phase: MessagePhase,
    ) -> None:
        pending = self.pending_message_deltas.pop(item_id, [])
        if pending and item_id not in self.streamed_messages:
            await self._emit_assistant_message(turn_id, item_id, "".join(pending), phase)

    async def _complete_assistant_message(
        self,
        turn_id: str,
        item_id: str,
        text: str,
        phase: MessagePhase | None,
    ) -> None:
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.ASSISTANT_COMPLETED,
            turn_id=turn_id,
            item_id=item_id,
            payload={"text": text, "phase": phase.value if phase is not None else ""},
        )

    async def _item_started(
        self,
        turn_id: str,
        item: Mapping[str, Any],
    ) -> None:
        item_type = str(item.get("type") or "")
        item_id = str(item.get("id") or "")
        if item_id:
            self._router.bind_item(item_id, self._thread.thread_id)
            self.item_details[item_id] = dict(item)
        if item_type == CODEX_COLLAB_TOOL_CALL_ITEM_TYPE:
            for agent_thread_id in collaboration_receivers(item):
                await self._emitter.emit(
                    self._thread,
                    CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
                    turn_id=turn_id,
                    item_id=f"{item_id}:{agent_thread_id}",
                    payload=collaboration_activity_payload(
                        item,
                        agent_thread_id=agent_thread_id,
                        completed=False,
                    ),
                )
            return
        if item_type == "agentMessage":
            await self._flush_unknown_message(
                turn_id,
                MessagePhase.COMMENTARY,
            )
            phase = _message_phase(item.get("phase"))
            if item_id and phase is not None:
                self.message_phases[item_id] = phase
                await self._flush_pending_message_deltas(turn_id, item_id, phase)
            return
        await self._flush_unknown_message(
            turn_id,
            MessagePhase.COMMENTARY,
        )
        if item_type == CODEX_WEB_SEARCH_ITEM_TYPE:
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.WEB_SEARCH_STARTED,
                turn_id=turn_id,
                item_id=item_id,
                payload=search_payload(item),
            )
            return
        if item_type == "commandExecution":
            skill = skill_for_command(self.active_skill_inputs, item)
            if skill is not None:
                self.skill_items[item_id] = skill
                await self._emitter.emit(
                    self._thread,
                    CodexSessionEventKind.SKILL_STARTED,
                    turn_id=turn_id,
                    item_id=item_id,
                    payload={
                        **skill_activity_payload(skill, completed=False, item=item),
                        "input": {"command": item.get("command"), "cwd": item.get("cwd")},
                    },
                )
                return
            name = command_name(item)
            self.item_names[item_id] = name
            payload: Mapping[str, JsonValue] = {
                "name": name,
                "input": {
                    "command": item.get("command"),
                    "cwd": item.get("cwd"),
                    "actions": item.get("commandActions") or [],
                },
            }
        elif item_type == "fileChange":
            self.item_names[item_id] = "file_change"
            payload = {"name": "file_change", "input": {"changes": item.get("changes") or []}}
        elif item_type == "mcpToolCall":
            name = (
                f"{MCP_TOOL_NAME_PREFIX}{item.get('server') or 'mcp'}"
                f"__{item.get('tool') or 'tool'}"
            )
            self.item_names[item_id] = name
            payload = {"name": name, "input": item.get("arguments") or {}}
        elif item_type == "dynamicToolCall":
            name = str(item.get("tool") or "dynamic_tool")
            self.item_names[item_id] = name
            payload = {"name": name, "input": item.get("arguments") or {}}
        else:
            if item_type in CODEX_DEDICATED_ITEM_TYPES:
                return
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
                turn_id=turn_id,
                item_id=item_id,
                payload=native_activity_payload(item, completed=False),
            )
            return
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.TOOL_STARTED,
            turn_id=turn_id,
            item_id=item_id,
            payload=payload,
        )

    async def _item_completed(
        self,
        turn_id: str,
        item: Mapping[str, Any],
    ) -> None:
        item_type = str(item.get("type") or "")
        item_id = str(item.get("id") or "")
        if item_type == CODEX_COLLAB_TOOL_CALL_ITEM_TYPE:
            started = self.item_details.get(item_id, {})
            receivers = tuple(
                dict.fromkeys(
                    (
                        *collaboration_receivers(started),
                        *collaboration_receivers(item),
                    )
                )
            )
            item = {**started, **item, "receiverThreadIds": list(receivers)}
            for agent_thread_id in receivers:
                await self._emitter.emit(
                    self._thread,
                    CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
                    turn_id=turn_id,
                    item_id=f"{item_id}:{agent_thread_id}",
                    payload=collaboration_activity_payload(
                        item,
                        agent_thread_id=agent_thread_id,
                        completed=True,
                    ),
                )
            return
        if item_type == "agentMessage":
            pending = self.pending_message_deltas.pop(item_id, [])
            text = str(item.get("text") or "") or "".join(pending)
            phase = _message_phase(item.get("phase")) or self.message_phases.get(item_id)
            if item_id and phase is not None:
                self.message_phases[item_id] = phase
            if phase is None:
                if text:
                    await self._flush_unknown_message(
                        turn_id,
                        MessagePhase.COMMENTARY,
                    )
                    self.pending_unknown_messages[turn_id] = (item_id, text)
                return
            await self._flush_unknown_message(
                turn_id,
                MessagePhase.COMMENTARY,
            )
            if text and item_id not in self.streamed_messages:
                await self._emit_assistant_message(turn_id, item_id, text, phase)
            elif text and phase != MessagePhase.COMMENTARY:
                self.final_text = text
            await self._complete_assistant_message(turn_id, item_id, text, phase)
            return
        if item_type == CODEX_WEB_SEARCH_ITEM_TYPE:
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.WEB_SEARCH_COMPLETED,
                turn_id=turn_id,
                item_id=item_id,
                payload=search_payload(item),
            )
            return
        skill = self.skill_items.get(item_id)
        if item_type == "commandExecution" and skill is not None:
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.SKILL_COMPLETED,
                turn_id=turn_id,
                item_id=item_id,
                payload={
                    **skill_activity_payload(skill, completed=True, item=item),
                    "output": str(
                        item.get("aggregatedOutput") or self.item_output.get(item_id, "")
                    ),
                    "exit_code": item.get("exitCode"),
                },
            )
            return
        if item_type not in {"commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"}:
            if item_type in CODEX_DEDICATED_ITEM_TYPES:
                return
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
                turn_id=turn_id,
                item_id=item_id,
                payload=native_activity_payload(item, completed=True),
            )
            return
        status = str(item.get("status") or "")
        if (
            item_type == "commandExecution"
            and isinstance(item.get("exitCode"), int)
            and item["exitCode"] != 0
        ):
            status = "failed"
        elif item_type in {"mcpToolCall", "dynamicToolCall"} and item.get("error"):
            status = "failed"
        output = str(item.get("aggregatedOutput") or self.item_output.get(item_id, ""))
        if item_type == "fileChange":
            changes = list(item.get("changes") or [])
            output = json.dumps(changes, ensure_ascii=False)
            if status == "completed":
                for change in changes:
                    if not isinstance(change, Mapping):
                        continue
                    relative = workspace_relative_path(self._thread.request.cwd, change.get("path"))
                    if relative:
                        self.explicit_file_paths.add(relative)
                await self._emitter.emit(
                    self._thread,
                    CodexSessionEventKind.FILE_CHANGED,
                    turn_id=turn_id,
                    item_id=item_id,
                    payload={"changes": changes, "status": status},
                )
        elif item_type == "mcpToolCall":
            output = json.dumps(
                item.get("result") or item.get("error") or {},
                ensure_ascii=False,
                default=str,
            )
        elif item_type == "dynamicToolCall":
            output = json.dumps(
                item.get("contentItems") or item.get("error") or [],
                ensure_ascii=False,
                default=str,
            )
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.TOOL_COMPLETED,
            turn_id=turn_id,
            item_id=item_id,
            payload={
                "name": self.item_names.get(item_id, item_type),
                "output": output,
                "ok": status == "completed",
                "status": status,
                **({"exit_code": item.get("exitCode")} if item_type == "commandExecution" else {}),
            },
        )

    async def _turn_completed(self, turn: Mapping[str, Any]) -> None:
        async with self._completion_lock:
            turn_id = str(turn.get("id") or self.active_turn_id)
            if turn_id in self._settled_turns:
                return
            status = self._turn_status(str(turn.get("status") or "failed"))
            resumed_client_id = next(
                (
                    snapshot.client_id
                    for snapshot in self.resume_turns
                    if snapshot.turn_id == turn_id
                ),
                "",
            )
            client_id = str(
                turn.get("clientId")
                or turn.get("clientUserMessageId")
                or self.turn_client_ids.get(turn_id)
                or self.active_turn_client_id
                or resumed_client_id
            )
            self.resume_turns = replace_turn_snapshot(
                self.resume_turns,
                ResumeTurnSnapshot(client_id, turn_id, status),
            )
            await self._flush_unknown_message(
                turn_id,
                (
                    MessagePhase.FINAL_ANSWER
                    if status == TurnStatus.COMPLETED
                    else MessagePhase.COMMENTARY
                ),
            )
            await self._stale_requests(self._thread.thread_id, turn_id, "turn_completed")
            terminal_error_code, terminal_error_message = self._turn_error(turn.get("error"))
            failure = (
                provider_failure(turn.get("error"))
                if terminal_error_code or terminal_error_message
                else self.provider_failure or provider_failure(None)
            )
            if status == TurnStatus.FAILED:
                logger.info(
                    "codex_turn_failed thread_id=%s turn_id=%s code=%s http_status=%s",
                    self._thread.thread_id,
                    turn_id,
                    failure.diagnostic_code,
                    failure.http_status,
                )
            await self._close_provider_incident(
                turn_id,
                recovered=status == TurnStatus.COMPLETED,
                generation=self._generation,
                failure=failure,
            )
            # A terminal failure or user stop does not undo files already written.
            # Surface those durable results just like files from a successful turn.
            await self._flush_watched_files(turn_id)
            event_kind = {
                TurnStatus.COMPLETED: CodexSessionEventKind.TURN_COMPLETED,
                TurnStatus.INTERRUPTED: CodexSessionEventKind.TURN_INTERRUPTED,
                TurnStatus.FAILED: CodexSessionEventKind.TURN_FAILED,
            }[status]
            resolved_ambiguous_incident_id = self.ambiguous_incident_id
            await self._emitter.emit(
                self._thread,
                event_kind,
                turn_id=turn_id,
                payload={
                    "status": status.value,
                    "error": failure.message if status == TurnStatus.FAILED else "",
                    "error_code": failure.code if status == TurnStatus.FAILED else "",
                    "safe_error": failure.message if status == TurnStatus.FAILED else "",
                    "retryability": (
                        failure.retryability.value if status == TurnStatus.FAILED else ""
                    ),
                    "process_generation": self._generation,
                    "resolved_ambiguous_incident_id": resolved_ambiguous_incident_id,
                },
            )
            self.ambiguous_submission_id = ""
            self.ambiguous_incident_id = ""
            self.ambiguous_generation = 0
            self.active_turn_id = ""
            self.active_turn_client_id = ""
            self.turn_client_ids.pop(turn_id, None)
            self._router.forget_turn(turn_id)
            for item_id in self.turn_items.pop(turn_id, set()):
                self._router.forget_item(item_id)
            self.active_skill_inputs.clear()
            self.skill_items.clear()
            self.provider_failure = None
            if self.turn_done is not None and not self.turn_done.done():
                self.turn_done.set_result(dict(turn))
            self._settled_turns.add(turn_id)

    async def _flush_watched_files(self, turn_id: str) -> None:
        await self._watcher.finish_turn(self)
        changes = observed_changes(
            self._thread.request.cwd, self.watched_paths, self.explicit_file_paths
        )
        self.watched_paths.clear()
        self.explicit_file_paths.clear()
        if not changes:
            return
        await self._emitter.emit(
            self._thread,
            CodexSessionEventKind.FILE_CHANGED,
            turn_id=turn_id,
            item_id=self.fs_watch_id,
            payload={"changes": changes, "status": "completed"},
        )

    async def _settle_provider_retry(
        self,
        turn_id: str,
        generation: int,
    ) -> None:
        if (
            not self.provider_incident_id
            or not turn_id
            or turn_id != self.provider_incident_turn_id
            or self.provider_incident_kind is not RuntimeIncidentKind.PROVIDER_RETRY
        ):
            return
        await self._close_provider_incident(turn_id, recovered=True, generation=generation)

    async def _close_provider_incident(
        self,
        turn_id: str,
        *,
        recovered: bool,
        generation: int,
        failure: ProviderFailure | None = None,
    ) -> None:
        if not self.provider_incident_id:
            return
        if self.provider_incident_turn_id and self.provider_incident_turn_id != turn_id:
            return
        terminal_failure = failure or self.provider_failure or provider_failure(None)
        incident = RuntimeIncident(
            incident_id=self.provider_incident_id,
            scope=RuntimeIncidentScope.PROVIDER,
            state=(RuntimeIncidentState.RECOVERED if recovered else RuntimeIncidentState.FAILED),
            kind=self.provider_incident_kind,
            strategy=RuntimeRecoveryStrategy.NONE,
            retryability=(
                RuntimeRetryability.TERMINAL if recovered else terminal_failure.retryability
            ),
            safe_error=("codex_provider_recovered" if recovered else terminal_failure.message),
            process_generation=generation,
            vendor_thread_id=self._thread.thread_id,
            vendor_turn_id=turn_id,
            provider_error_code=terminal_failure.diagnostic_code,
            provider_http_status=terminal_failure.http_status,
        )
        await self._emitter.incident(self._thread, incident, turn_id=turn_id)
        self.provider_incident_id = ""
        self.provider_incident_turn_id = ""
        self.provider_incident_kind = RuntimeIncidentKind.PROVIDER_RETRY
        self.provider_failure = (
            terminal_failure
            if recovered and terminal_failure.retryability is RuntimeRetryability.TERMINAL
            else None
        )

    async def connection_lost(self, incident: RuntimeIncident, exit_generation: int) -> None:
        self.fs_watch_id = ""
        self.abandon_files()
        turn_id = self.active_turn_id
        interrupted_turn_id = self.interrupted_turn_id or turn_id
        if turn_id and not self.interrupted_turn_id:
            self.interrupted_turn_id = turn_id
            self.interrupted_turn_client_id = (
                self.turn_client_ids.get(turn_id) or self.active_turn_client_id
            )
            self.interrupted_turn_generation = exit_generation
        await self._stale_requests(self._thread.thread_id, "", "process_exit")
        if turn_id:
            await self._close_provider_incident(
                turn_id,
                recovered=False,
                generation=exit_generation,
            )
        await self._emitter.incident(self._thread, incident, turn_id=interrupted_turn_id)
        if turn_id:
            await self._emitter.emit(
                self._thread,
                CodexSessionEventKind.TURN_UNKNOWN,
                turn_id=turn_id,
                payload={
                    "status": "unknown",
                    "error": "process_exit",
                    "process_generation": exit_generation,
                },
                incident=incident,
            )
            self._router.bind_turn(turn_id, self._thread.thread_id)
            for item_id in self.turn_items.pop(turn_id, set()):
                self._router.forget_item(item_id)
        if self.turn_done is not None and not self.turn_done.done():
            self.turn_done.set_result(
                {
                    "id": turn_id,
                    "status": "unknown",
                    "error": {"message": "Codex App Server process exited"},
                }
            )
        self.active_turn_id = ""
        self.active_turn_client_id = ""
