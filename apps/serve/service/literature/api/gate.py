"""Product-owned full-text authorization gate for skill-written literature candidate sets."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from typing import Any, Mapping

from service.assistant.service.authorization import (
    AuthorizationDisposition,
    FulltextAuthorization,
    FulltextAuthorizer,
    authorization_question,
    decision_disposition,
)
from service.chat.constants import (
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_SESSION_STATE_IDLE,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
)
from service.chat.persistence.catalog import SessionStatus
from service.chat.runtime.live import LiveSession
from service.chat.service.cards import DisplayCardError
from service.chat.service.turns import TurnService
from service.literature.service.checkpoint import (
    CheckpointContent,
    PreparedCheckpoint,
    discover_triggers,
    read_checkpoint,
)
from service.literature.service.result import ARTIFACT_REFERENCE_FIELDS, SEARCH_CARD
from service.platform.bridge import ArtifactPublishFailure, DisplayCardContent

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


async def authorize_sources(
    live: LiveSession,
    authorizer: FulltextAuthorizer,
    *,
    turn_id: str,
    snapshot_id: str,
    authorization_type: str,
    refs: tuple[str, ...],
) -> tuple[FulltextAuthorization, AuthorizationDisposition, Mapping[str, Any] | None]:
    """Ask once per exact source set; an earlier durable allow in this Session is reused.

    Returns the challenge, its disposition and the new decision when the user was asked now.
    """

    challenge = authorizer.prepare(
        session_id=live.id,
        snapshot_id=snapshot_id,
        turn_id=turn_id,
        authorization_type=authorization_type,
        refs=refs,
    )
    if authorizer.granted(challenge) or authorizer.granted_scope(
        session_id=live.id, authorization_type=authorization_type, refs=refs
    ):
        return challenge, AuthorizationDisposition.AUTHORIZED, None
    decision = await live.interactions.request_product_input(
        authorization_question(challenge), turn_id=turn_id
    )
    return challenge, decision_disposition(challenge, decision), decision


class FulltextGate:
    """Pause a turn when a candidate set appears, ask in ScholarSeed, then resume the task."""

    def __init__(
        self,
        authorizer: FulltextAuthorizer,
        turns: TurnService,
        *,
        poll_seconds: float = GATE_POLL_SECONDS,
    ) -> None:
        self._authorizer = authorizer
        self._turns = turns
        self._poll_seconds = poll_seconds
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._watchers: dict[str, asyncio.Task[None]] = {}
        self._dirty: set[str] = set()
        self._asked: set[tuple[str, str, str, str]] = set()

    def observe(self, live: LiveSession) -> None:
        """Schedule one serialized scan; called synchronously from runtime projection."""

        self._watch(live)
        task = self._tasks.get(live.id)
        if task is not None and not task.done():
            self._dirty.add(live.id)
            return
        self._tasks[live.id] = asyncio.create_task(self._run(live))

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
                if task is not None and not task.done():
                    self._dirty.add(live.id)
                else:
                    self._tasks[live.id] = asyncio.create_task(self._run(live))
        finally:
            if self._watchers.get(live.id) is asyncio.current_task():
                self._watchers.pop(live.id, None)

    async def wait_idle(self, session_id: str) -> None:
        task = self._tasks.get(session_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self, live: LiveSession) -> None:
        try:
            while True:
                self._dirty.discard(live.id)
                checkpoint = await asyncio.to_thread(self._pending, live)
                if checkpoint is not None:
                    await self._gate(live, checkpoint)
                if live.id not in self._dirty:
                    return
        except Exception:  # noqa: BLE001 - a failed scan must not break runtime projection
            logger.exception("fulltext_gate_failed session_id=%s", live.id)
        finally:
            if self._tasks.get(live.id) is asyncio.current_task():
                self._tasks.pop(live.id, None)

    @staticmethod
    def _ask_key(live: LiveSession, checkpoint: PreparedCheckpoint) -> tuple[str, str, str, str]:
        scope = SCOPE_SEPARATOR.join(sorted(checkpoint.content.refs)).encode("utf-8")
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
            if checkpoint is None or self._ask_key(live, checkpoint) in self._asked:
                continue
            refs = checkpoint.content.refs
            if self._authorizer.granted_scope(
                session_id=live.id, authorization_type=policy.authorization_type, refs=refs
            ):
                continue
            challenges = self._authorizer.session_scope(
                session_id=live.id, authorization_type=policy.authorization_type, refs=refs
            )
            # Asked in this turn already, by this gate or a blocking bridge checkpoint.
            if started_ns > 0 and any(
                challenge.created_at * NANOSECONDS_PER_SECOND >= started_ns
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

    async def _gate(self, live: LiveSession, checkpoint: PreparedCheckpoint) -> None:
        client_turn_id = live.last_submission_id
        if not client_turn_id:
            return
        turn_id = live.ledger.active_turn_id or client_turn_id
        snapshot_id = live.active_assistant_snapshot_id or client_turn_id
        task_type = live.active_task_type or checkpoint.policy.task_type.value
        # Turn state is cleared when the interrupted turn ends; the continuation keeps its context.
        context_revision = live.active_assistant_revision
        if not turn_id or live.interrupting or live.terminating or live.terminated:
            return
        self._asked.add(self._ask_key(live, checkpoint))
        interrupted = False
        if live.running:
            task = live.current_task
            await live.interrupt()
            interrupted = True
            await live.ledger.wait_terminal(turn_id)
            if task is not None:
                await asyncio.wait({task})
        await self._publish_card(live, checkpoint, turn_id)
        challenge, disposition, decision = await authorize_sources(
            live,
            self._authorizer,
            turn_id=turn_id,
            snapshot_id=snapshot_id,
            authorization_type=checkpoint.policy.authorization_type,
            refs=checkpoint.content.refs,
        )
        cancelled = decision is not None and bool(decision.get(GATE_DECISION_CANCELLED))
        if decision is not None:
            await self._settle(live, turn_id, interrupted)
        if cancelled or live.terminating or live.terminated:
            return
        if disposition is AuthorizationDisposition.AUTHORIZED:
            text = CONTINUATION_AUTHORIZED.format(count=len(checkpoint.content.sources))
        elif checkpoint.policy.continue_on_reject:
            text = CONTINUATION_REJECTED
        else:
            return
        continuation_id = uuid.uuid4().hex
        if disposition is AuthorizationDisposition.AUTHORIZED:
            self._authorizer.bind_continuation(challenge, continuation_id)
        body: dict[str, Any] = {
            "input": [{"type": "text", "text": text}],
            "task_type": task_type,
            "client_user_message_id": continuation_id,
        }
        if context_revision is not None:
            body["assistant_context_revision"] = context_revision
        payload, _status = await self._turns.post(live.id, body, side=False)
        if not payload.get("ok"):
            logger.warning(
                "fulltext_gate_continuation_rejected session_id=%s error=%s",
                live.id,
                payload.get("error"),
            )

    async def _settle(self, live: LiveSession, turn_id: str, interrupted: bool) -> None:
        """The paused turn has already ended; resolving its product question must not look live."""

        if live.running:
            return
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
    live: LiveSession, content: CheckpointContent, turn_id: str
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
    return await live.display_card(SEARCH_CARD, DisplayCardContent(data=card), turn_id=turn_id)


__all__ = [
    "CONTINUATION_AUTHORIZED",
    "CONTINUATION_REJECTED",
    "FulltextGate",
    "authorize_sources",
    "publish_checkpoint_card",
]
