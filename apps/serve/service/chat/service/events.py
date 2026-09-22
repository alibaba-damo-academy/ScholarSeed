"""Durable product-event replay and live SSE subscription."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any, Mapping

from service.chat.constants import (
    EVENT_BACKLOG_MAX,
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_ARTIFACT_FAILED,
    PRODUCT_EVENT_DISPLAY_CARD,
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_PAPER_SEARCH_STARTED,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_SKILL_COMPLETED,
    PRODUCT_EVENT_SKILL_STARTED,
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
    SSE_CONNECTED_EVENT,
    SSE_DISCONNECTED_EVENT,
    SSE_HEARTBEAT_SECONDS,
    SSE_REPLAY_FINISHED_EVENT,
    SSE_REPLAY_STARTED_EVENT,
    USER_MESSAGE_BINDING_BOUND,
)
from service.chat.persistence.events import (
    MAXIMUM_REPLAY_LIMIT,
    ProductEventRecord,
    ProductEventStore,
)
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.runtime.live import LiveSession
from service.platform.context import ASSISTANT_CONTEXT_MARKER

SSE_DATA_PREFIX = "data: "
SSE_FRAME_SUFFIX = "\n\n"
SSE_HEARTBEAT_FRAME = ": keepalive\n\n"
HISTORY_ACTIVITY_EVENT_KINDS = frozenset(
    {
        PRODUCT_EVENT_ANSWER_SOURCES,
        PRODUCT_EVENT_ARTIFACT_FAILED,
        PRODUCT_EVENT_TURN_FAILED,
        PRODUCT_EVENT_MESSAGE_DELTA,
        PRODUCT_EVENT_REASONING_DELTA,
        PRODUCT_EVENT_TOOL_STARTED,
        PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
        PRODUCT_EVENT_TOOL_COMPLETED,
        PRODUCT_EVENT_WEB_SEARCH_STARTED,
        PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
        PRODUCT_EVENT_PAPER_SEARCH_STARTED,
        PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
        PRODUCT_EVENT_SKILL_STARTED,
        PRODUCT_EVENT_SKILL_COMPLETED,
        PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
        PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
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


def sse_encode(event: dict[str, Any]) -> str:
    return f"{SSE_DATA_PREFIX}{json.dumps(event, ensure_ascii=False, separators=(',', ':'))}{SSE_FRAME_SUFFIX}"


class EventService:
    """Replay committed events, then stream events published after commit."""

    def __init__(
        self,
        sessions: dict[str, LiveSession],
        events: ProductEventStore,
        logger: Any,
    ) -> None:
        self._sessions = sessions
        self._events = events
        self._logger = logger

    def portable_history(self, session_id: str) -> tuple[Any, ...]:
        """Return the durable provider-neutral messages owned by product events."""

        return self._events.portable_history(session_id)

    def activity_snapshot(self, session_id: str) -> list[dict[str, Any]]:
        """Return the ordered transcript timeline anchors and technical activity.

        Final assistant text remains owned by the authoritative Codex history.
        Message deltas are included only as ordered item anchors so the renderer
        can place semantic activity between complete assistant messages without
        replaying or duplicating their text.
        """

        snapshot: list[dict[str, Any]] = []
        last_sequence = 0
        while True:
            page = self._events.replay(
                session_id,
                after_seq=last_sequence,
                limit=MAXIMUM_REPLAY_LIMIT,
            )
            snapshot.extend(
                LiveSession.event_envelope(record)
                for record in page
                if record.kind in HISTORY_ACTIVITY_EVENT_KINDS
            )
            if not page or len(page) < MAXIMUM_REPLAY_LIMIT:
                break
            last_sequence = page[-1].product_seq
        return snapshot

    def turn_activity_snapshot(self, session_id: str) -> list[dict[str, Any]]:
        """Project durable turn timing and terminal truth for transcript activity.

        Product events are the only clock shared by live SSE and history replay.
        The initial admitted user event uses a client turn id; the later bound
        event connects that start timestamp to the vendor turn without making
        the renderer infer identities from transcript order.
        """

        records: list[ProductEventRecord] = []
        last_sequence = 0
        while True:
            page = self._events.replay(
                session_id,
                after_seq=last_sequence,
                limit=MAXIMUM_REPLAY_LIMIT,
            )
            records.extend(page)
            if not page or len(page) < MAXIMUM_REPLAY_LIMIT:
                break
            last_sequence = page[-1].product_seq

        admitted_at: dict[str, float] = {}
        bound_client_ids: dict[str, str] = {}
        for record in records:
            if record.kind != PRODUCT_EVENT_USER_MESSAGE:
                continue
            client_turn_id = str(record.payload.get("client_turn_id") or "").strip()
            if not client_turn_id:
                continue
            admitted_at[client_turn_id] = min(
                admitted_at.get(client_turn_id, record.created_at),
                record.created_at,
            )
            if (
                str(record.payload.get("binding") or "") == USER_MESSAGE_BINDING_BOUND
                and record.vendor_turn_id
            ):
                bound_client_ids[record.vendor_turn_id] = client_turn_id

        snapshots: dict[str, dict[str, Any]] = {}
        for record in records:
            turn_id = str(record.vendor_turn_id or "").strip()
            if not turn_id:
                continue
            if (
                record.kind == PRODUCT_EVENT_USER_MESSAGE
                and str(record.payload.get("binding") or "") != USER_MESSAGE_BINDING_BOUND
            ):
                continue
            snapshot = snapshots.setdefault(
                turn_id,
                {
                    "turn_id": turn_id,
                    "started_at": record.created_at,
                },
            )
            bound_client_id = bound_client_ids.get(turn_id)
            if bound_client_id is None and turn_id in admitted_at:
                bound_client_id = turn_id
            start = (
                admitted_at.get(bound_client_id, record.created_at)
                if bound_client_id is not None
                else record.created_at
            )
            snapshot["started_at"] = min(float(snapshot["started_at"]), start)
            outcome = TURN_OUTCOME_BY_EVENT_KIND.get(record.kind)
            if outcome is not None:
                snapshot["completed_at"] = record.created_at
                snapshot["outcome"] = outcome

        return sorted(
            snapshots.values(),
            key=lambda snapshot: (float(snapshot["started_at"]), str(snapshot["turn_id"])),
        )

    def decorate_history(
        self,
        session_id: str,
        turns: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Restore product-owned references onto Codex-owned transcript rows.

        Codex history owns message text and ordering, while uploads and Skill
        selections are ScholarSeed product metadata.  The durable ``user_message``
        event binds those two sources without asking the vendor runtime to
        preserve product presentation fields.
        """

        decorated = [dict(turn) for turn in turns]
        claimed: set[int] = set()
        messages = self._user_message_snapshot(session_id)
        turn_order = {
            str(record.vendor_turn_id): index
            for index, record in enumerate(messages)
            if record.vendor_turn_id
        }
        for record in messages:
            refs = record.payload.get("refs")
            references = (
                [dict(ref) for ref in refs if isinstance(ref, Mapping)]
                if isinstance(refs, list)
                else []
            )
            text = str(record.payload.get("text") or "")
            turn_id = str(record.vendor_turn_id or "")
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
                target = next(
                    (
                        row
                        for row in decorated
                        if id(row) not in claimed
                        and self._is_user_turn(row)
                        and str(row.get("text") or "") == text
                    ),
                    None,
                )
            if target is not None:
                target["text"] = text
                target["refs"] = references
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
                "turn_id": turn_id,
                "item_id": str(record.vendor_item_id or ""),
                "refs": references,
            }
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
        message_models: dict[tuple[str, str], dict[str, str]] = {}
        for event in self.activity_snapshot(session_id):
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
        return decorated

    def _user_message_snapshot(self, session_id: str) -> list[ProductEventRecord]:
        latest: dict[str, ProductEventRecord] = {}
        order: list[str] = []
        last_sequence = 0
        while True:
            page = self._events.replay(
                session_id,
                after_seq=last_sequence,
                limit=MAXIMUM_REPLAY_LIMIT,
            )
            for record in page:
                if record.kind != PRODUCT_EVENT_USER_MESSAGE:
                    continue
                client_turn_id = str(
                    record.payload.get("client_turn_id")
                    or record.vendor_item_id
                    or record.vendor_turn_id
                    or record.product_seq
                )
                if client_turn_id not in latest:
                    order.append(client_turn_id)
                latest[client_turn_id] = record
            if not page or len(page) < MAXIMUM_REPLAY_LIMIT:
                break
            last_sequence = page[-1].product_seq
        return [latest[client_turn_id] for client_turn_id in order]

    @staticmethod
    def _is_user_turn(turn: Mapping[str, Any]) -> bool:
        return str(turn.get("kind") or "") == "user" or (
            str(turn.get("kind") or "") == "text" and str(turn.get("role") or "") == "user"
        )

    async def open(self, session_id: str, from_seq: int) -> AsyncGenerator[str, None]:
        live = self._sessions.get(session_id)
        queue: asyncio.Queue[dict[str, Any]] | None = None
        if live is not None:
            queue = asyncio.Queue(maxsize=EVENT_BACKLOG_MAX)
            live.subscribers.append(queue)
        self._logger.info(
            SSE_CONNECTED_EVENT,
            extra={
                "session_id": session_id,
                "subscribers": len(live.subscribers) if live is not None else 0,
                "from_seq": int(from_seq or 0),
            },
        )
        last = max(0, int(from_seq or 0))
        try:
            self._logger.debug(
                SSE_REPLAY_STARTED_EVENT,
                extra={"session_id": session_id, "from_seq": last},
            )
            replayed = 0
            while True:
                page = self._events.replay(
                    session_id,
                    after_seq=last,
                    limit=MAXIMUM_REPLAY_LIMIT,
                )
                for record in page:
                    envelope = LiveSession.event_envelope(record)
                    yield sse_encode(envelope)
                    last = record.product_seq
                    replayed += 1
                if len(page) < MAXIMUM_REPLAY_LIMIT:
                    break
            self._logger.debug(
                SSE_REPLAY_FINISHED_EVENT,
                extra={
                    "session_id": session_id,
                    "from_seq": int(from_seq or 0),
                    "last_seq": last,
                    "replayed": replayed,
                },
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
                while True:
                    page = self._events.replay(
                        session_id, after_seq=last, limit=MAXIMUM_REPLAY_LIMIT
                    )
                    for record in page:
                        yield sse_encode(LiveSession.event_envelope(record))
                        last = record.product_seq
                        delivered = True
                    if len(page) < MAXIMUM_REPLAY_LIMIT:
                        break
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
