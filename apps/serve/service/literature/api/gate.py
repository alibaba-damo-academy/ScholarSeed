"""Product-owned full-text authorization gate for skill-written literature candidate sets."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from collections.abc import Callable, Coroutine
from functools import partial
from typing import Any, Mapping

from service.assistant.service.authorization import (
    AuthorizationDisposition,
    FulltextAuthorization,
    FulltextAuthorizer,
    authorization_policy,
    authorize_sources,
)
from service.chat.constants import (
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_SESSION_STATE_IDLE,
    PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
)
from service.chat.persistence.catalog import SessionStatus
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
NANOSECONDS_PER_SECOND = 1_000_000_000
SCOPE_SEPARATOR = "\n"
CONTINUATION_PLAN = (
    "若已有执行计划，先 `scholarseed-bridge plan get` 取得当前轮次与 revision，"
    "再对同一 plan_id 执行 update 继续，不要新建计划。"
)
CONTINUATION_AUTHORIZED = (
    "书深：已获得一键授权，可在本任务内下载、读取并使用刚才展示的 {count} 篇文献全文。"
    "请从中断处继续原任务，直接进入下载或全文阶段；不要重新检索、重新选择文献或再次询问授权。"
    + CONTINUATION_PLAN
)
CONTINUATION_REJECTED = (
    "书深：用户拒绝了全文授权。请不要读取任何文献全文，仅基于标题和摘要从中断处继续原任务；"
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
        self._bridge_inflight: dict[
            BridgeAuthorizationKey, asyncio.Task[BridgeAuthorizationResult]
        ] = {}

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
    ) -> BridgeAuthorizationResult:
        if task_context is None:
            task_context = verified_authorization_context(
                live, authorization_policy(authorization_type).task_type
            )
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
        )
        result = (challenge, disposition, decision)
        if decision is None or decision.get(GATE_DECISION_CANCELLED):
            return result
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
    def _ask_key(
        live: LiveSession,
        checkpoint: PreparedCheckpoint,
        task_context: FulltextTaskContext | None = None,
    ) -> tuple[str, str, str, str]:
        task_key = FulltextAuthorizer.task_key(
            live.id, checkpoint.policy.authorization_type, task_context
        )
        scope = SCOPE_SEPARATOR.join((task_key, *sorted(checkpoint.content.refs))).encode("utf-8")
        return (
            live.id,
            live.last_submission_id,
            checkpoint.policy.authorization_type,
            hashlib.sha256(scope).hexdigest(),
        )

    def _pending(self, live: LiveSession) -> PreparedCheckpoint | None:
        # Duplicate suppression is per turn; earlier turns of this Session are no longer needed.
        self._asked = {
            key for key in self._asked if key[0] != live.id or key[1] == live.last_submission_id
        }
        if live.terminating or live.terminated or not live.last_submission_id:
            return None
        started_ns = int(live.active_turn_started_at * NANOSECONDS_PER_SECOND)
        for policy, trigger, modified_ns in discover_triggers(
            live.runtime_workdir, live.active_task_type
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
        await self._publish_card(live, checkpoint, turn_id)
        challenge, disposition, decision = await authorize_sources(
            live,
            self._authorizer,
            turn_id=turn_id,
            snapshot_id=snapshot_id,
            authorization_type=checkpoint.policy.authorization_type,
            refs=checkpoint.content.refs,
            papers=tuple(
                {"id": source.ref_id, "label": source.title}
                for source in checkpoint.content.sources
            ),
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
    ) -> None:
        if (
            live.terminating
            or live.terminated
            or live.interrupt_generation != expected_interrupt_generation
        ):
            return
        if disposition is AuthorizationDisposition.AUTHORIZED:
            text = CONTINUATION_AUTHORIZED.format(count=count)
        elif continue_on_reject:
            text = CONTINUATION_REJECTED
        else:
            return
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
        )
        if not payload.get("ok"):
            logger.warning(
                "fulltext_gate_continuation_rejected session_id=%s error=%s",
                live.id,
                payload.get("error"),
            )

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
    ) -> None:
        try:
            await publish_checkpoint_card(live, checkpoint.content, turn_id)
        except (ValueError, OSError, DisplayCardError, ArtifactPublishFailure):
            # The authorization question still names the exact scope; a missing card is not a grant.
            logger.warning(
                "fulltext_gate_card_failed session_id=%s trigger=%s",
                live.id,
                checkpoint.content.trigger,
                exc_info=True,
            )


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
