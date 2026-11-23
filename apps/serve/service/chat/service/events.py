"""Durable product-event replay and live SSE subscription."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator, Iterator
from typing import Any, Mapping

from service.chat.constants import (
    CANCELLED_MESSAGE_HISTORY_PREFIX,
    EVENT_BACKLOG_MAX,
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_ARTIFACT_FAILED,
    PRODUCT_EVENT_DISPLAY_CARD,
    PRODUCT_EVENT_GENERATION_PREVIEW,
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_PAPER_SEARCH_STARTED,
    PRODUCT_EVENT_PLAN_SNAPSHOT,
    PRODUCT_EVENT_REASONING_COMPLETED,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_SKILL_COMPLETED,
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_SOURCE_CANDIDATES,
    PRODUCT_EVENT_SUBAGENT_COMPLETED,
    PRODUCT_EVENT_SUBAGENT_FAILED,
    PRODUCT_EVENT_SUBAGENT_INTERRUPTED,
    PRODUCT_EVENT_SUBAGENT_SPAWNED,
    PRODUCT_EVENT_SUBAGENT_STARTED,
    PRODUCT_EVENT_SUBAGENT_STATUS_CHANGED,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
    PRODUCT_EVENT_WEB_SEARCH_STARTED,
    PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_TURN_OUTCOME_FAILED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    RETIRED_DISPLAY_CARD_TYPES,
    SSE_CONNECTED_EVENT,
    SSE_DISCONNECTED_EVENT,
    SSE_HEARTBEAT_SECONDS,
    SSE_REPLAY_FINISHED_EVENT,
    SSE_REPLAY_STARTED_EVENT,
    USER_MESSAGE_BINDING_BOUND,
    USER_MESSAGE_BINDING_CANCELLED,
)
from service.chat.persistence.events import (
    MAXIMUM_REPLAY_LIMIT,
    ProductEventRecord,
    ProductEventStore,
    cancelled_message_text,
)
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.runtime.live import LiveSession
from service.chat.service.plan import PlanToolProjection
from service.platform.activity import Activities
from service.platform.context import ASSISTANT_CONTEXT_MARKER
from service.platform.latency import RequestPhases
from service.platform.sse import SSE_HEARTBEAT_FRAME, sse_encode

SSE_REPLAY_PAGE_SIZE = 2_048
HISTORY_ACTIVITY_EVENT_KINDS = frozenset(
    {
        PRODUCT_EVENT_ANSWER_SOURCES,
        PRODUCT_EVENT_GENERATION_PREVIEW,
        PRODUCT_EVENT_ARTIFACT_FAILED,
        PRODUCT_EVENT_TURN_FAILED,
        PRODUCT_EVENT_TURN_INTERRUPTED,
        PRODUCT_EVENT_MESSAGE_DELTA,
        PRODUCT_EVENT_REASONING_DELTA,
        PRODUCT_EVENT_REASONING_COMPLETED,
        PRODUCT_EVENT_TOOL_STARTED,
        PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
        PRODUCT_EVENT_TOOL_COMPLETED,
        PRODUCT_EVENT_WEB_SEARCH_STARTED,
        PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
        PRODUCT_EVENT_SOURCE_CANDIDATES,
        PRODUCT_EVENT_PAPER_SEARCH_STARTED,
        PRODUCT_EVENT_PLAN_SNAPSHOT,
        PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
        PRODUCT_EVENT_SKILL_STARTED,
        PRODUCT_EVENT_SKILL_COMPLETED,
        PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
        PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
        PRODUCT_EVENT_SUBAGENT_SPAWNED,
        PRODUCT_EVENT_SUBAGENT_STARTED,
        PRODUCT_EVENT_SUBAGENT_STATUS_CHANGED,
        PRODUCT_EVENT_SUBAGENT_COMPLETED,
        PRODUCT_EVENT_SUBAGENT_FAILED,
        PRODUCT_EVENT_SUBAGENT_INTERRUPTED,
        PRODUCT_EVENT_DISPLAY_CARD,
        PRODUCT_EVENT_REVIEW_READY,
        PRODUCT_EVENT_HIL_REQUESTED,
        PRODUCT_EVENT_HIL_RESOLVED,
    }
)
TURN_OUTCOME_BY_EVENT_KIND = {
    PRODUCT_EVENT_TURN_COMPLETED: PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED: PRODUCT_TURN_OUTCOME_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED: PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN: PRODUCT_TURN_OUTCOME_UNKNOWN,
}
ASSISTANT_HISTORY_INCOMPLETE = "assistant_context_history_incomplete"
ASSISTANT_HISTORY_INCOMPLETE_TEXT = "上下文历史投影不完整，请重新发送该问题。"


class _TurnClocks:
    """Accumulate turn clocks in sequence order and resolve late user bindings at the end."""

    def __init__(self) -> None:
        self._admitted: dict[str, float] = {}
        self._bound: dict[str, str] = {}
        self._first: dict[str, float] = {}
        self._turns: dict[str, dict[str, Any]] = {}

    def observe(self, record: ProductEventRecord) -> None:
        turn_id = str(record.vendor_turn_id or "").strip()
        if record.kind == PRODUCT_EVENT_USER_MESSAGE:
            client_id = str(record.payload.get("client_turn_id") or "").strip()
            if client_id:
                self._admitted[client_id] = min(
                    self._admitted.get(client_id, record.created_at), record.created_at
                )
            if record.payload.get("binding") != USER_MESSAGE_BINDING_BOUND:
                return
            if client_id and record.vendor_turn_id:
                self._bound[record.vendor_turn_id] = client_id
        if not turn_id:
            return

        turn = self._turns.get(turn_id)
        if turn is None:
            turn = {"turn_id": turn_id, "started_at": record.created_at}
            self._turns[turn_id] = turn
            self._first[turn_id] = record.created_at
        else:
            turn["started_at"] = min(turn["started_at"], record.created_at)
        outcome = TURN_OUTCOME_BY_EVENT_KIND.get(record.kind)
        if outcome is not None:
            turn["completed_at"] = record.created_at
            turn["outcome"] = outcome

    def snapshot(self) -> list[dict[str, Any]]:
        for turn_id, turn in self._turns.items():
            admitted = self._admitted.get(self._bound.get(turn_id, turn_id))
            if admitted is not None:
                # The first eligible event caps the product admission time. Without
                # an admission, the earliest observed timestamp remains authoritative.
                turn["started_at"] = min(self._first[turn_id], admitted)
        return sorted(self._turns.values(), key=lambda row: (row["started_at"], row["turn_id"]))


class EventService:
    """Replay committed events, then stream events published after commit."""

    def __init__(
        self,
        sessions: dict[str, LiveSession],
        events: ProductEventStore,
        logger: Any,
        *,
        activities: Activities | None = None,
    ) -> None:
        self._sessions = sessions
        self._events = events
        self._logger = logger
        self._activities = activities if activities is not None else Activities()

    def portable_history(self, session_id: str) -> tuple[Any, ...]:
        """Return the durable provider-neutral messages owned by product events."""

        return self._events.portable_history(session_id)

    def _records(
        self, session_id: str, *, kinds: tuple[str, ...] | None = None
    ) -> Iterator[ProductEventRecord]:
        after_seq = 0
        while True:
            page = self._events.replay(
                session_id, after_seq=after_seq, limit=MAXIMUM_REPLAY_LIMIT, kinds=kinds
            )
            yield from page
            if len(page) < MAXIMUM_REPLAY_LIMIT:
                return
            after_seq = page[-1].product_seq

    def activity_snapshot(
        self, session_id: str, *, compact_activity: bool = False
    ) -> list[dict[str, Any]]:
        """Return the ordered transcript timeline anchors and technical activity.

        Final assistant text remains owned by the authoritative Codex history.
        Message deltas are included only as ordered item anchors so the renderer
        can place semantic activity between complete assistant messages without
        replaying or duplicating their text.
        """

        return self._activity_snapshot(session_id, compact_activity=compact_activity)

    def _activity_snapshot(
        self, session_id: str, *, compact_activity: bool, clocks: _TurnClocks | None = None
    ) -> list[dict[str, Any]]:
        snapshot: list[dict[str, Any]] = []
        projection = PlanToolProjection()
        previous_anchor = None
        has_tail = False
        for original in self._records(session_id):
            if clocks is not None:
                clocks.observe(original)
            record = projection.project(original)
            if record.kind not in HISTORY_ACTIVITY_EVENT_KINDS or (
                record.kind == PRODUCT_EVENT_DISPLAY_CARD
                and record.payload.get("type") in RETIRED_DISPLAY_CARD_TYPES
            ):
                continue
            event = LiveSession.event_envelope(record)
            anchor = None
            if (
                compact_activity
                and record.kind == PRODUCT_EVENT_MESSAGE_DELTA
                and record.vendor_turn_id
                and record.vendor_item_id
            ):
                # Cumulative updates can share an anchor only while all non-text
                # metadata matches. Retain the real first and last envelopes.
                anchor = (
                    record.runtime_id,
                    record.vendor_thread_id,
                    record.schema_version,
                    record.vendor_turn_id,
                    record.vendor_item_id,
                    {key: value for key, value in event["data"].items() if key != "delta"},
                )
            same_anchor = anchor is not None and anchor == previous_anchor
            if same_anchor and has_tail:
                snapshot[-1] = event
            else:
                snapshot.append(event)
            previous_anchor = anchor
            has_tail = same_anchor
        return snapshot

    def turn_activity_snapshot(self, session_id: str) -> list[dict[str, Any]]:
        """Project durable turn timing and terminal truth for transcript activity.

        Product events are the only clock shared by live SSE and history replay.
        The initial admitted user event uses a client turn id; the later bound
        event connects that start timestamp to the vendor turn without making
        the renderer infer identities from transcript order.
        """

        clocks = _TurnClocks()
        for record in self._records(session_id):
            clocks.observe(record)
        return clocks.snapshot()

    def decorate_history(
        self,
        session_id: str,
        turns: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Restore product-owned references and model provenance onto history rows."""

        decorated, _activity, _timing = self.history_snapshot(session_id, turns)
        return decorated

    def history_snapshot(
        self,
        session_id: str,
        turns: list[dict[str, Any]],
        *,
        phases: RequestPhases | None = None,
        compact_activity: bool = False,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        """Restore product-owned references and return the activity used by this transcript.

        Codex history owns message text and ordering, while uploads and Skill
        selections are ScholarSeed product metadata.  The durable ``user_message``
        event binds those two sources without asking the vendor runtime to
        preserve product presentation fields.
        """

        decorated = [dict(turn) for turn in turns]
        claimed: set[int] = set()
        messages = self._user_message_snapshot(session_id)
        if phases is not None:
            phases.mark("user_events")
        turn_order = {
            str(record.vendor_turn_id or record.payload.get("client_turn_id") or ""): index
            for index, (record, _sent_at) in enumerate(messages)
            if record.vendor_turn_id
            or str(record.payload.get("binding") or "") == USER_MESSAGE_BINDING_CANCELLED
        }
        for record, sent_at in messages:
            cancelled = str(record.payload.get("binding") or "") == USER_MESSAGE_BINDING_CANCELLED
            refs = record.payload.get("refs")
            references = (
                [dict(ref) for ref in refs if isinstance(ref, Mapping)]
                if isinstance(refs, list)
                else []
            )
            text = str(record.payload.get("text") or "")
            turn_id = str(
                record.vendor_turn_id
                or (record.payload.get("client_turn_id") if cancelled else "")
                or ""
            )
            target = next(
                (
                    row
                    for row in decorated
                    if id(row) not in claimed
                    and self._is_user_turn(row)
                    and turn_id
                    and str(row.get("turn_id") or "") == turn_id
                ),
                None,
            )
            if target is None:
                native_text = (
                    CANCELLED_MESSAGE_HISTORY_PREFIX
                    + json.dumps(cancelled_message_text(record.payload), ensure_ascii=False)
                    if cancelled
                    else text
                )
                target = next(
                    (
                        row
                        for row in decorated
                        if id(row) not in claimed
                        and self._is_user_turn(row)
                        and str(row.get("text") or "") == native_text
                    ),
                    None,
                )
            if target is not None:
                target["text"] = text
                target["sent_at"] = sent_at
                target["refs"] = references
                if cancelled:
                    target["status"] = USER_MESSAGE_BINDING_CANCELLED
                    target["turn_id"] = turn_id
                    target["item_id"] = str(record.vendor_item_id or turn_id)
                if record.payload.get("origin"):
                    target["origin"] = str(record.payload["origin"])
                if record.payload.get("assistant_snapshot_id"):
                    target["assistant_snapshot_id"] = str(record.payload["assistant_snapshot_id"])
                    target["assistant_context_revision"] = record.payload.get(
                        "assistant_context_revision"
                    )
                claimed.add(id(target))
                continue
            synthetic: dict[str, Any] = {
                "kind": "user",
                "role": "user",
                "text": text,
                "sent_at": sent_at,
                "turn_id": turn_id,
                "item_id": str(record.vendor_item_id or (turn_id if cancelled else "")),
                "refs": references,
            }
            if cancelled:
                synthetic["status"] = USER_MESSAGE_BINDING_CANCELLED
            if record.payload.get("origin"):
                synthetic["origin"] = str(record.payload["origin"])
            if record.payload.get("assistant_snapshot_id"):
                synthetic["assistant_snapshot_id"] = str(record.payload["assistant_snapshot_id"])
                synthetic["assistant_context_revision"] = record.payload.get(
                    "assistant_context_revision"
                )
            anchor = next(
                (
                    index
                    for index, row in enumerate(decorated)
                    if turn_id and str(row.get("turn_id") or "") == turn_id
                ),
                len(decorated),
            )
            if anchor == len(decorated) and turn_id in turn_order:
                # A rejected turn may be absent from native history entirely.
                # Preserve the product submission order instead of appending an
                # old failed request after newer successful conversations.
                anchor = next(
                    (
                        index
                        for index, row in enumerate(decorated)
                        if str(row.get("turn_id") or "") in turn_order
                        and turn_order[str(row["turn_id"])] > turn_order[turn_id]
                    ),
                    len(decorated),
                )
            decorated.insert(anchor, synthetic)
            claimed.add(id(synthetic))
        for row in decorated:
            text = str(row.get("text") or "")
            if not self._is_user_turn(row) or not text.startswith(ASSISTANT_CONTEXT_MARKER):
                continue
            row["text"] = ASSISTANT_HISTORY_INCOMPLETE_TEXT
            row["projection_error"] = ASSISTANT_HISTORY_INCOMPLETE
            self._logger.error(
                ASSISTANT_HISTORY_INCOMPLETE,
                extra={"session_id": session_id, "turn_id": str(row.get("turn_id") or "")},
            )
        if phases is not None:
            phases.mark("user_metadata")
        clocks = _TurnClocks()
        activity = self._activity_snapshot(
            session_id, compact_activity=compact_activity, clocks=clocks
        )
        if phases is not None:
            phases.mark("activity_and_timing")
        message_models: dict[tuple[str, str], dict[str, str]] = {}
        for event in activity:
            if event["type"] != PRODUCT_EVENT_MESSAGE_DELTA:
                continue
            run = ModelRun.restore(event["data"].get(MODEL_RUN_FIELD))
            if run is not None:
                message_models[
                    (str(event.get("turn_id") or ""), str(event.get("item_id") or ""))
                ] = run.payload()
        for row in decorated:
            if row.get("role") != "assistant":
                continue
            identity = (str(row.get("turn_id") or ""), str(row.get("item_id") or ""))
            if identity in message_models:
                row[MODEL_RUN_FIELD] = message_models[identity]
        if phases is not None:
            phases.mark("model_provenance")
        timing = clocks.snapshot()
        if phases is not None:
            phases.mark("turn_activity")
        return decorated, activity, timing

    def _user_message_snapshot(self, session_id: str) -> list[tuple[ProductEventRecord, float]]:
        latest: dict[str, tuple[ProductEventRecord, float]] = {}
        order: list[str] = []
        for record in self._records(session_id, kinds=(PRODUCT_EVENT_USER_MESSAGE,)):
            client_turn_id = str(
                record.payload.get("client_turn_id")
                or record.vendor_item_id
                or record.vendor_turn_id
                or record.product_seq
            )
            if client_turn_id not in latest:
                order.append(client_turn_id)
            sent_at = latest[client_turn_id][1] if client_turn_id in latest else record.created_at
            latest[client_turn_id] = (record, sent_at)
        return [latest[client_turn_id] for client_turn_id in order]

    @staticmethod
    def _is_user_turn(turn: Mapping[str, Any]) -> bool:
        return str(turn.get("kind") or "") == "user" or (
            str(turn.get("kind") or "") == "text" and str(turn.get("role") or "") == "user"
        )

    def _sse_page(
        self, session_id: str, *, after_seq: int, from_seq: int, projection: PlanToolProjection
    ) -> tuple[int, int, list[tuple[int, str]]]:
        page = self._events.replay(session_id, after_seq=after_seq, limit=SSE_REPLAY_PAGE_SIZE)
        frames = []
        for original in page:
            record = projection.project(original)
            if record.product_seq > from_seq:
                frames.append((record.product_seq, sse_encode(LiveSession.event_envelope(record))))
        return (page[-1].product_seq if page else after_seq), len(page), frames

    async def _sse_pages(
        self, session_id: str, *, after_seq: int, from_seq: int, projection: PlanToolProjection
    ) -> AsyncGenerator[tuple[int, list[tuple[int, str]]], None]:
        while True:
            after_seq, scanned, frames = await self._activities.finish_observed_thread(
                self._sse_page,
                session_id,
                after_seq=after_seq,
                from_seq=from_seq,
                projection=projection,
            )
            if scanned:
                yield scanned, frames
            if scanned < SSE_REPLAY_PAGE_SIZE:
                return

    async def open(self, session_id: str, from_seq: int) -> AsyncGenerator[str, None]:
        live = self._sessions.get(session_id)
        queue: asyncio.Queue[dict[str, Any]] | None = None
        if live is not None:
            queue = asyncio.Queue(maxsize=EVENT_BACKLOG_MAX)
            async with live.lifecycle_lock:
                live.subscribers.append(queue)
        self._logger.info(
            SSE_CONNECTED_EVENT,
            extra={
                "session_id": session_id,
                "subscribers": len(live.subscribers) if live is not None else 0,
                "from_seq": int(from_seq or 0),
            },
        )
        from_seq = last = max(0, int(from_seq or 0))
        projection = PlanToolProjection()
        try:
            started = time.monotonic()
            self._logger.info(
                "%s session_id=%s from_seq=%s started_at=%.3f",
                SSE_REPLAY_STARTED_EVENT,
                session_id,
                from_seq,
                time.time(),
            )
            scanned = 0
            replayed = 0
            # The plan projection needs the prefix even when the client is at the head.
            async for count, frames in self._sse_pages(
                session_id, after_seq=0, from_seq=from_seq, projection=projection
            ):
                if live is not None and queue not in live.subscribers:
                    return
                scanned += count
                for last, frame in frames:
                    yield frame
                    replayed += 1
            self._logger.info(
                "%s session_id=%s from_seq=%s last_seq=%s scanned=%s replayed=%s "
                "elapsed_ms=%.3f finished_at=%.3f",
                SSE_REPLAY_FINISHED_EVENT,
                session_id,
                from_seq,
                last,
                scanned,
                replayed,
                (time.monotonic() - started) * 1_000,
                time.time(),
            )
            while True:
                if queue is None:
                    await asyncio.sleep(SSE_HEARTBEAT_SECONDS)
                else:
                    try:
                        await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
                    except TimeoutError:
                        pass
                    if live is not None and queue not in live.subscribers:
                        return
                # Notifications are wakeups, never the sequence source. Product
                # writers outside the agent loop can commit between live events.
                delivered = False
                async for _, frames in self._sse_pages(
                    session_id, after_seq=last, from_seq=last, projection=projection
                ):
                    if live is not None and queue not in live.subscribers:
                        return
                    for last, frame in frames:
                        yield frame
                        delivered = True
                if not delivered:
                    yield SSE_HEARTBEAT_FRAME
        finally:
            if live is not None and queue is not None and queue in live.subscribers:
                live.subscribers.remove(queue)
            self._logger.info(
                SSE_DISCONNECTED_EVENT,
                extra={
                    "session_id": session_id,
                    "subscribers": len(live.subscribers) if live is not None else 0,
                },
            )


__all__ = ["EventService", "sse_encode"]
