"""Product-owned full-text authorization gate for skill-written literature candidate sets."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import uuid
from collections.abc import Callable, Coroutine
from functools import partial
from typing import Any, Mapping

from service.assistant.service.authorization import (
    AUTHORIZATION_REQUIRED,
    AuthorizationDisposition,
    FulltextAuthorization,
    FulltextAuthorizer,
    authorization_policy,
    authorization_question,
    authorize_sources,
    decision_disposition,
)
from service.chat.constants import (
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_SESSION_STATE_IDLE,
    PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
)
from service.chat.persistence.catalog import QUEUE_PURPOSE_AUTHORIZATION, SessionStatus
from service.chat.runtime.live import LiveSession
from service.chat.service.cards import DisplayCardError
from service.chat.service.tasks import authorization_context_current, verified_authorization_context
from service.chat.service.turns import TurnService
from service.literature.service.checkpoint import (
    CheckpointContent,
    PreparedCheckpoint,
    discover_triggers,
    policy_for,
    read_checkpoint,
)
from service.literature.service.fulltexts import PAPER_REF_PREFIX
from service.literature.service.result import ARTIFACT_REFERENCE_FIELDS, SEARCH_CARD
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityLease,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.bridge import ArtifactPublishFailure, DisplayCardContent
from service.platform.context import FulltextTaskContext

GATE_ARTIFACT_ROLE = "supporting"
# One tool call can run several skill stages; files are also rescanned while it runs.
GATE_POLL_SECONDS = 2.0
GATE_DECISION_CANCELLED = "cancelled"
REAUTHORIZATION_DISPLAY = "已重新授权，继续原任务。"
REAUTHORIZATION_STALE = "fulltext_reauthorization_stale"
NANOSECONDS_PER_SECOND = 1_000_000_000
SCOPE_SEPARATOR = "\n"
CONTINUATION_PLAN = "沿用已有任务和执行进度，不要重新创建任务、不要重新检索或重复请求同范围授权。"
CONTINUATION_LIMITS = (
    "本消息仅通知授权结果，不是新的任务指令；继续遵守原用户任务的目标、范围、禁止事项和停止条件。"
    "若用户只要求确认授权，或要求授权决定后停止，请仅确认本次授权结果，不要执行后续任务。"
)
CONTINUATION_AUTHORIZED = (
    "[书深内部授权通知] 已授权 {count} 篇文献。"
    + CONTINUATION_LIMITS
    + "仅当原任务要求且允许获取全文时继续，授权不代表已下载或入库。"
    + CONTINUATION_PLAN
)
CONTINUATION_REJECTED = (
    "[书深内部授权通知] 用户拒绝全文授权，不得读取未授权全文。"
    + CONTINUATION_LIMITS
    + "仅当原任务允许基于标题和摘要继续时，才从中断处继续原任务；"
    "结果需标注“未读取原文”，不要生成页码引用。" + CONTINUATION_PLAN
)

logger = logging.getLogger(__name__)
BridgeAuthorizationKey = tuple[str, str, str, str, str, tuple[str, ...], int]
BridgeAuthorizationResult = tuple[
    FulltextAuthorization, AuthorizationDisposition, Mapping[str, Any] | None
]


class FulltextGate:
    """Pause a turn when a candidate set appears, ask in ScholarSeed, then resume the task."""

    def __init__(
        self,
        authorizer: FulltextAuthorizer,
        turns: TurnService,
        *,
        activities: Activities,
        poll_seconds: float = GATE_POLL_SECONDS,
    ) -> None:
        self._activities = activities
        self._authorizer = authorizer
        self._turns = turns
        self._poll_seconds = poll_seconds
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._watchers: dict[str, asyncio.Task[None]] = {}
        self._dirty: set[str] = set()
        self._asked: set[tuple[str, str, str, str]] = set()
        self._bridge_tasks: set[asyncio.Task[Any]] = set()
        self._resumed: set[tuple[str, str]] = set()
        self._bridge_inflight: dict[
            BridgeAuthorizationKey, asyncio.Task[BridgeAuthorizationResult]
        ] = {}

    async def retry(
        self, live: LiveSession, question_id: str, *, context_revision: int
    ) -> dict[str, Any]:
        async with live.activation_lock:
            if live.running or live.terminating or live.terminated:
                raise ValueError(REAUTHORIZATION_STALE)
            original = self._authorizer.challenge(live.id, question_id)
            task_type = authorization_policy(original.authorization_type).task_type
            if task_type is None:
                raise ValueError(REAUTHORIZATION_STALE)
            renewed_question_id = (
                authorization_policy(original.authorization_type).question_prefix
                + uuid.uuid5(uuid.NAMESPACE_URL, question_id).hex
            )
            if any(
                record.product_request_id != renewed_question_id
                for record in live.catalog.pending_hil(live.id)
            ):
                raise ValueError(REAUTHORIZATION_STALE)
            await self._activities.to_thread(
                ActivityDomain.BRIDGE, self._retry_context, live, original
            )
            renewed = self._authorizer.reopen(live.id, question_id)
            previous = live.catalog.hil(question_id)
            question = previous.payload.get("questions", [{}])[0]
            papers = tuple(question.get("papers", ()))
            key = (
                live.id,
                renewed.turn_id,
                renewed.snapshot_id,
                renewed.authorization_type,
                renewed.task_key,
                renewed.refs,
                len(renewed.refs),
            )
            if (
                key not in self._bridge_inflight
                and (live.id, renewed.question_id) not in self._resumed
            ):
                lease = self._activities.enter(ActivityDomain.BRIDGE, root=True)
                task = self._spawn(
                    lease,
                    partial(
                        self._retry,
                        live,
                        renewed,
                        papers,
                        task_type.value,
                        live.last_submission_id,
                        live.interrupt_generation,
                        lease,
                        str(question.get("result_card_id") or ""),
                        context_revision,
                    ),
                )
                self._bridge_inflight[key] = task
                self._bridge_tasks.add(task)

                def clear(completed: asyncio.Task[Any]) -> None:
                    self._bridge_tasks.discard(completed)
                    if self._bridge_inflight.get(key) is completed:
                        del self._bridge_inflight[key]

                task.add_done_callback(clear)
            return {"ok": True, "request_id": renewed.question_id}

    def _retry_context(
        self, live: LiveSession, original: FulltextAuthorization
    ) -> FulltextTaskContext | None:
        policy = authorization_policy(original.authorization_type)
        if policy.task_type is None:
            raise ValueError(REAUTHORIZATION_STALE)
        binding = live.catalog.task_binding(live.id)
        command = binding.get("command", {}) if binding else {}
        if original.task_key and (
            not binding
            or binding.get("owner_id") != live.user_id
            or command.get("task_type") != policy.task_type.value
        ):
            raise ValueError(REAUTHORIZATION_STALE)
        for checkpoint_policy, trigger, modified_ns in discover_triggers(
            live.runtime_workdir,
            policy.task_type.value,
            (
                command.get("workspace")
                if command.get("task_type") == policy.task_type.value
                else None
            ),
        ):
            checkpoint = read_checkpoint(
                live.runtime_workdir, checkpoint_policy, trigger, modified_ns
            )
            if checkpoint is None or not set(original.refs) <= set(checkpoint.content.refs):
                continue
            context = None
            if original.task_key:
                if (
                    command.get("workspace") != checkpoint.content.workspace
                    or command.get("run_id") != checkpoint.content.card.run_id
                ):
                    continue
                context = FulltextTaskContext(
                    owner_id=live.user_id,
                    project_id=live.project_id or "",
                    session_id=live.id,
                    workdir=os.path.normcase(str(live.runtime_workdir.resolve())),
                    task_type=policy.task_type,
                    workspace=checkpoint.content.workspace,
                    run_id=checkpoint.content.card.run_id,
                )
            else:
                record = live.catalog.get(live.id)
                if record is None or record.last_turn_id != original.turn_id:
                    continue
            if (
                self._authorizer.task_key(live.id, original.authorization_type, context)
                == original.task_key
            ):
                return context
        raise ValueError(REAUTHORIZATION_STALE)

    async def _retry(
        self,
        live: LiveSession,
        renewed: FulltextAuthorization,
        papers: tuple[Mapping[str, str], ...],
        task_type: str,
        submission_id: str,
        interrupt_generation: int,
        activity: ActivityLease,
        result_card_id: str,
        context_revision: int,
    ) -> BridgeAuthorizationResult:
        if (
            live.last_submission_id != submission_id
            or live.interrupt_generation != interrupt_generation
            or live.terminating
            or live.terminated
        ):
            return renewed, AuthorizationDisposition.REJECTED, None
        decision = await live.interactions.request_product_input(
            authorization_question(renewed, papers, result_card_id=result_card_id),
            turn_id=renewed.turn_id,
            activity=activity,
        )
        disposition = decision_disposition(renewed, decision)
        if not self._authorizer.granted_refs(renewed):
            disposition = AuthorizationDisposition.REJECTED
        if not decision.get(GATE_DECISION_CANCELLED):
            resumed = await self._continue(
                live,
                renewed,
                disposition,
                task_type=task_type,
                context_revision=context_revision,
                count=len(self._authorizer.granted_refs(renewed)),
                continue_on_reject=False,
                display_text=REAUTHORIZATION_DISPLAY,
                expected_submission_id=submission_id,
                expected_interrupt_generation=interrupt_generation,
                activity=activity,
            )
            if resumed:
                self._resumed.add((live.id, renewed.question_id))
        return renewed, disposition, decision

    async def authorize_sources(
        self,
        live: LiveSession,
        *,
        turn_id: str,
        snapshot_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
        source_count: int,
        papers: tuple[Mapping[str, str], ...] = (),
        task_context: FulltextTaskContext | None = None,
        result_card_id: str = "",
    ) -> BridgeAuthorizationResult:
        if task_context is None:
            task_type = authorization_policy(authorization_type).task_type
            if task_type is None:
                raise ValueError(AUTHORIZATION_REQUIRED)
            task_context = verified_authorization_context(live, task_type)
        task_key = self._authorizer.task_key(live.id, authorization_type, task_context)
        key = (live.id, turn_id, snapshot_id, authorization_type, task_key, refs, source_count)
        task = self._bridge_inflight.get(key)
        if task is None:
            lease = self._activities.continue_from(live.turn_activity, ActivityDomain.BRIDGE)
            task = self._spawn(
                lease,
                partial(
                    self._authorize_bridge,
                    live,
                    turn_id=turn_id,
                    snapshot_id=snapshot_id,
                    authorization_type=authorization_type,
                    refs=refs,
                    source_count=source_count,
                    papers=papers,
                    task_context=task_context,
                    submission_id=live.last_submission_id,
                    task_type=live.active_task_type,
                    context_revision=live.active_assistant_revision,
                    origin_task=live.current_task,
                    interrupt_generation=live.interrupt_generation,
                    activity=lease,
                    result_card_id=result_card_id,
                ),
            )
            self._bridge_inflight[key] = task
            self._bridge_tasks.add(task)

            def clear(completed: asyncio.Task[BridgeAuthorizationResult]) -> None:
                self._bridge_tasks.discard(completed)
                if self._bridge_inflight.get(key) is completed:
                    del self._bridge_inflight[key]

            task.add_done_callback(clear)
        return await asyncio.shield(task)

    def granted_refs(
        self,
        live: LiveSession,
        *,
        turn_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
        task_context: FulltextTaskContext | None,
    ) -> tuple[str, ...]:
        return self._authorizer.effective_scope(
            session_id=live.id,
            snapshot_id=live.active_assistant_snapshot_id,
            turn_id=turn_id,
            authorization_type=authorization_type,
            refs=refs,
            client_turn_id=getattr(live, "active_product_turn_id", ""),
            task_context=task_context,
        ).allowed

    async def _authorize_bridge(
        self,
        live: LiveSession,
        *,
        turn_id: str,
        snapshot_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
        source_count: int,
        papers: tuple[Mapping[str, str], ...],
        task_context: FulltextTaskContext | None,
        submission_id: str,
        task_type: str,
        context_revision: int | None,
        origin_task: asyncio.Task[Any] | None,
        interrupt_generation: int,
        activity: ActivityLease,
        result_card_id: str,
    ) -> tuple[FulltextAuthorization, AuthorizationDisposition, Mapping[str, Any] | None]:
        challenge, disposition, decision = await authorize_sources(
            live,
            self._authorizer,
            turn_id=turn_id,
            snapshot_id=snapshot_id,
            authorization_type=authorization_type,
            refs=refs,
            papers=papers,
            task_context=task_context,
            activity=activity,
            result_card_id=result_card_id,
        )
        result = (challenge, disposition, decision)
        if decision is None or decision.get(GATE_DECISION_CANCELLED):
            return result
        self._asked.add(
            self._scope_key(live.id, submission_id, authorization_type, refs, task_context)
        )
        if live.ledger.active_turn_id == turn_id:
            return result
        record = live.catalog.get(live.id)
        if (
            record is None
            or record.last_turn_id != turn_id
            or record.last_turn_status != PRODUCT_TURN_OUTCOME_COMPLETED
        ):
            return result
        if origin_task is not None and not origin_task.done():
            await asyncio.wait({origin_task})
        policy = policy_for(authorization_type)
        await self._continue(
            live,
            challenge,
            disposition,
            task_type=task_type,
            context_revision=context_revision,
            count=len(
                self._authorizer.turn_granted_refs(
                    session_id=live.id,
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=authorization_type,
                    refs=tuple(ref for ref in refs if ref.startswith(PAPER_REF_PREFIX)),
                    client_turn_id=getattr(live, "active_product_turn_id", ""),
                    task_context=task_context,
                )
            ),
            continue_on_reject=policy.continue_on_reject,
            expected_submission_id=submission_id,
            expected_interrupt_generation=interrupt_generation,
            activity=activity,
        )
        return result

    def observe(self, live: LiveSession) -> None:
        """Schedule one serialized scan; called synchronously from runtime projection."""

        self._watch(live)
        task = self._tasks.get(live.id)
        if task is not None and not task.done():
            self._dirty.add(live.id)
            return
        self._start_scan(live)

    def _spawn(
        self, lease: ActivityLease, operation: Callable[[], Coroutine[Any, Any, Any]]
    ) -> asyncio.Task[Any]:
        async def execute() -> Any:
            with lease:
                return await operation()

        coroutine = execute()
        try:
            task = asyncio.create_task(coroutine)
        except BaseException:
            coroutine.close()
            lease.close()
            raise
        task.add_done_callback(lambda _done: lease.close())
        return task

    def _start_scan(self, live: LiveSession) -> None:
        try:
            try:
                lease = self._activities.continue_from(live.turn_activity, ActivityDomain.BRIDGE)
            except MaintenanceStale:
                # Final runtime projections may arrive after their turn has settled.
                lease = self._activities.enter(ActivityDomain.BRIDGE, root=True)
        except MaintenanceActive:
            self._tasks[live.id] = asyncio.create_task(self._resume_scan(live))
            return
        self._tasks[live.id] = self._spawn(lease, lambda: self._run(live, lease))

    async def _resume_scan(self, live: LiveSession) -> None:
        # Waiting is passive: no filesystem/catalog work may start before admission.
        try:
            await self._activities.wait_open()
            if not live.terminating and not live.terminated:
                self._start_scan(live)
                await self.wait_idle(live.id)
        finally:
            if self._tasks.get(live.id) is asyncio.current_task():
                self._tasks.pop(live.id, None)

    def _watch(self, live: LiveSession) -> None:
        if self._poll_seconds <= 0 or not live.running:
            return
        watcher = self._watchers.get(live.id)
        if watcher is None or watcher.done():
            self._watchers[live.id] = asyncio.create_task(self._poll(live))

    async def _poll(self, live: LiveSession) -> None:
        """Rescan during a long tool call, before later stages can consume the candidates."""

        try:
            while True:
                await asyncio.sleep(self._poll_seconds)
                if live.terminating or live.terminated or not live.running:
                    return
                task = self._tasks.get(live.id)
                if task is None or task.done():
                    # A periodic tick does not invalidate an in-progress scan. Marking
                    # every slow scan dirty can keep it running forever; runtime
                    # events still request an immediate rescan through observe().
                    self._start_scan(live)
        finally:
            if self._watchers.get(live.id) is asyncio.current_task():
                self._watchers.pop(live.id, None)

    async def wait_idle(self, session_id: str) -> None:
        task = self._tasks.get(session_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self, live: LiveSession, activity: ActivityLease) -> None:
        try:
            while True:
                self._dirty.discard(live.id)
                checkpoint = await self._activities.finish(
                    ActivityDomain.BRIDGE,
                    lambda: self._activities.to_thread(ActivityDomain.BRIDGE, self._pending, live),
                )
                if checkpoint is not None:
                    await self._gate(live, checkpoint, activity)
                if live.id not in self._dirty:
                    return
        except Exception:  # noqa: BLE001 - a failed scan must not break runtime projection
            logger.exception("fulltext_gate_failed session_id=%s", live.id)
        finally:
            if self._tasks.get(live.id) is asyncio.current_task():
                self._tasks.pop(live.id, None)

    @staticmethod
    def _scope_key(
        session_id: str,
        submission_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
        task_context: FulltextTaskContext | None = None,
    ) -> tuple[str, str, str, str]:
        task_key = FulltextAuthorizer.task_key(session_id, authorization_type, task_context)
        scope = SCOPE_SEPARATOR.join((task_key, *sorted(refs))).encode("utf-8")
        return (
            session_id,
            submission_id,
            authorization_type,
            hashlib.sha256(scope).hexdigest(),
        )

    @staticmethod
    def _ask_key(
        live: LiveSession,
        checkpoint: PreparedCheckpoint,
        task_context: FulltextTaskContext | None = None,
    ) -> tuple[str, str, str, str]:
        return FulltextGate._scope_key(
            live.id,
            live.last_submission_id,
            checkpoint.policy.authorization_type,
            checkpoint.content.refs,
            task_context,
        )

    def _pending(self, live: LiveSession) -> PreparedCheckpoint | None:
        # Duplicate suppression is per turn; earlier turns of this Session are no longer needed.
        self._asked = {
            key for key in self._asked if key[0] != live.id or key[1] == live.last_submission_id
        }
        if live.terminating or live.terminated or not live.last_submission_id:
            return None
        started_ns = int(live.active_turn_started_at * NANOSECONDS_PER_SECOND)
        lease = getattr(live, "active_task_lease", None)
        workspace = (
            lease.workspace if lease and lease.task_type.value == live.active_task_type else None
        )
        for policy, trigger, modified_ns in discover_triggers(
            live.runtime_workdir, live.active_task_type, workspace
        ):
            checkpoint = read_checkpoint(live.runtime_workdir, policy, trigger, modified_ns)
            if checkpoint is None:
                continue
            try:
                task_context = verified_authorization_context(
                    live,
                    policy.task_type,
                    workspace=checkpoint.content.workspace,
                    run_id=checkpoint.content.card.run_id,
                )
            except ValueError:
                continue
            if self._ask_key(live, checkpoint, task_context) in self._asked:
                continue
            refs = checkpoint.content.refs
            scope = self._authorizer.effective_scope(
                session_id=live.id,
                snapshot_id=live.active_assistant_snapshot_id,
                turn_id=live.ledger.active_turn_id or live.last_submission_id,
                authorization_type=policy.authorization_type,
                refs=refs,
                client_turn_id=getattr(live, "active_product_turn_id", ""),
                task_context=task_context,
            )
            if not scope.unknown:
                continue
            challenges = scope.authorizations
            # Asked in this turn already, by this gate or a blocking bridge checkpoint.
            if started_ns > 0 and any(
                challenge.created_at * NANOSECONDS_PER_SECOND >= started_ns
                and self._authorizer.pending(challenge)
                and set(scope.unknown) <= set(challenge.refs)
                for challenge in challenges
            ):
                continue
            fresh = started_ns > 0 and modified_ns >= started_ns
            # A stopped task keeps its unanswered or rejected set gated in later turns.
            previously_gated = not policy.continue_on_reject and bool(challenges)
            if not (fresh or previously_gated):
                continue
            started = policy.consumption_started
            if started is not None and not started(live.runtime_workdir, trigger, modified_ns):
                # The task is expected to wait on its bridge checkpoint in this same turn.
                continue
            return checkpoint
        return None

    async def _gate(
        self, live: LiveSession, checkpoint: PreparedCheckpoint, activity: ActivityLease
    ) -> None:
        client_turn_id = live.last_submission_id
        if not client_turn_id:
            return
        native_turn_id = live.ledger.active_turn_id
        turn_id = native_turn_id or client_turn_id
        snapshot_id = live.active_assistant_snapshot_id or client_turn_id
        task_type = live.active_task_type or checkpoint.policy.task_type.value
        task_context = verified_authorization_context(
            live,
            checkpoint.policy.task_type,
            workspace=checkpoint.content.workspace,
            run_id=checkpoint.content.card.run_id,
        )
        # Turn state is cleared when the interrupted turn ends; the continuation keeps its context.
        context_revision = live.active_assistant_revision
        interrupt_generation = live.interrupt_generation
        if not turn_id or live.interrupting or live.terminating or live.terminated:
            return
        terminal_outcome: str | None = None
        if live.running:
            task = live.current_task
            await live.interrupt(cleanup_background_processes=True)
            interrupt_generation = live.interrupt_generation
            # A product task can still be cleaning up after its native turn ended.
            # The authorization's client-ID fallback can never receive a native terminal.
            if native_turn_id:
                terminal_outcome = await live.ledger.wait_terminal(native_turn_id)
            if task is not None and not task.done():
                await asyncio.wait({task})
        if live.last_submission_id != client_turn_id or not authorization_context_current(
            live, task_context
        ):
            return
        self._asked.add(self._ask_key(live, checkpoint, task_context))
        result_card_id = await self._publish_card(live, checkpoint, turn_id)
        challenge, disposition, decision = await authorize_sources(
            live,
            self._authorizer,
            turn_id=turn_id,
            snapshot_id=snapshot_id,
            authorization_type=checkpoint.policy.authorization_type,
            refs=checkpoint.content.refs,
            papers=tuple(
                {"id": source.ref_id, "label": source.title, "description": ""}
                for source in checkpoint.content.sources
            ),
            result_card_id=result_card_id,
            task_context=task_context,
            activity=activity,
        )
        cancelled = decision is not None and bool(decision.get(GATE_DECISION_CANCELLED))
        if decision is not None:
            await self._settle(live, turn_id, terminal_outcome)
        if cancelled or live.terminating or live.terminated:
            return
        await self._continue(
            live,
            challenge,
            disposition,
            task_type=task_type,
            context_revision=context_revision,
            count=len(
                self._authorizer.turn_granted_refs(
                    session_id=live.id,
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=checkpoint.policy.authorization_type,
                    refs=tuple(source.ref_id for source in checkpoint.content.sources),
                    client_turn_id=client_turn_id,
                    task_context=task_context,
                )
            ),
            continue_on_reject=checkpoint.policy.continue_on_reject,
            expected_submission_id=client_turn_id,
            expected_interrupt_generation=interrupt_generation,
            activity=activity,
        )

    async def _continue(
        self,
        live: LiveSession,
        challenge: FulltextAuthorization,
        disposition: AuthorizationDisposition,
        *,
        task_type: str,
        context_revision: int | None,
        count: int,
        continue_on_reject: bool,
        expected_submission_id: str,
        expected_interrupt_generation: int,
        activity: ActivityLease,
        display_text: str | None = None,
    ) -> bool:
        if (
            live.terminating
            or live.terminated
            or live.interrupt_generation != expected_interrupt_generation
        ):
            return False
        if disposition is AuthorizationDisposition.AUTHORIZED:
            text = CONTINUATION_AUTHORIZED.format(count=count)
        elif continue_on_reject:
            text = CONTINUATION_REJECTED
        else:
            return False
        continuation_id = uuid.uuid5(uuid.NAMESPACE_URL, challenge.question_id).hex
        if disposition is AuthorizationDisposition.AUTHORIZED and not challenge.task_key:
            for authorization in self._authorizer.turn_scope(
                session_id=live.id,
                snapshot_id=challenge.snapshot_id,
                turn_id=challenge.turn_id,
                authorization_type=challenge.authorization_type,
            ):
                if self._authorizer.granted(authorization):
                    self._authorizer.bind_continuation(authorization, continuation_id)
        body: dict[str, Any] = {
            "input": [{"type": "text", "text": text}],
            "task_type": task_type,
            "client_user_message_id": continuation_id,
        }
        if context_revision is not None:
            body["assistant_context_revision"] = context_revision
        payload, _status = await self._turns.post(
            live.id,
            body,
            side=False,
            expected_submission_id=expected_submission_id,
            expected_interrupt_generation=expected_interrupt_generation,
            continuation_activity=activity,
            purpose=QUEUE_PURPOSE_AUTHORIZATION,
            display_text=display_text,
        )
        if not payload.get("ok"):
            logger.warning(
                "fulltext_gate_continuation_rejected session_id=%s error=%s",
                live.id,
                payload.get("error"),
            )
        return bool(payload.get("ok"))

    async def _settle(self, live: LiveSession, turn_id: str, terminal_outcome: str | None) -> None:
        """The paused turn has already ended; resolving its product question must not look live."""

        if live.running:
            return
        if terminal_outcome == PRODUCT_TURN_OUTCOME_UNKNOWN:
            if not await live.ledger.reconcile_controlled_interrupt(turn_id):
                return
        else:
            interrupted = terminal_outcome == PRODUCT_TURN_OUTCOME_INTERRUPTED
            live.catalog.update_status(
                live.id,
                SessionStatus.INTERRUPTED if interrupted else SessionStatus.READY,
                turn_id=turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_INTERRUPTED if interrupted else None,
            )
        await live.publish(
            PRODUCT_EVENT_SESSION_STATE,
            {"state": PRODUCT_SESSION_STATE_IDLE, "runtime_id": live.runtime_id},
            turn_id=turn_id,
        )

    async def _publish_card(
        self, live: LiveSession, checkpoint: PreparedCheckpoint, turn_id: str
    ) -> str:
        try:
            card = await publish_checkpoint_card(live, checkpoint.content, turn_id)
            return str(card.get("card_id") or "")
        except (ValueError, OSError, DisplayCardError, ArtifactPublishFailure):
            # The authorization question still names the exact scope; a missing card is not a grant.
            logger.warning(
                "fulltext_gate_card_failed session_id=%s trigger=%s",
                live.id,
                checkpoint.content.trigger,
                exc_info=True,
            )
            return ""


async def publish_checkpoint_card(
    live: LiveSession, content: CheckpointContent, turn_id: str, *, skill_name: str = ""
) -> dict[str, Any]:
    """Publish a candidate set's exact files and its literature-search card."""

    update: dict[str, Any] = {"session_id": live.id}
    for artifact in content.artifacts:
        published = await live.publish_artifact(
            artifact.path,
            GATE_ARTIFACT_ROLE,
            turn_id=turn_id,
            expected_sha256=artifact.digest,
        )
        if artifact.field:
            reference = {key: published.get(key) for key in ARTIFACT_REFERENCE_FIELDS}
            if artifact.title:
                reference["title"] = artifact.title
            update[artifact.field] = reference
    card = content.card.model_copy(update=update).model_dump(mode="json")
    return await live.display_card(
        SEARCH_CARD, DisplayCardContent(data=card, skill=skill_name), turn_id=turn_id
    )


__all__ = [
    "CONTINUATION_AUTHORIZED",
    "CONTINUATION_REJECTED",
    "FulltextGate",
    "publish_checkpoint_card",
]
