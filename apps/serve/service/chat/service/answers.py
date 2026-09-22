"""Stable product-owned assistant answer lookup."""

from __future__ import annotations

import hashlib

from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
)
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.platform.context import (
    ASSISTANT_ANSWER_ID_PREFIX,
    SHA256_REVISION_PREFIX,
    AssistantAnswer,
)

FINAL_ANSWER_PHASE = "final_answer"

# Selectable turn message identifiers. Frontend renders these as "any kind" of
# annotatable message. Legacy "answer:{seq}" is kept for backwards compatibility;
# `item:{vendor_item_id}` is the canonical form used for thinking/tool and, for
# newly created annotations, for agent answers too.
ITEM_MESSAGE_ID_PREFIX = "item:"


class ProductAnswerSource:
    """Resolve completed final answers from the durable product event ledger.

    Historically this returned only the final agent answer. It now also
    resolves reasoning ("thinking") and tool-completed messages, so that any
    part of a completed turn shown in the transcript can be annotated or
    excerpted using the same identity contract used for agent answers.
    """

    def __init__(self, events: ProductEventStore) -> None:
        self._events = events

    def answer(self, *, session_id: str, answer_id: str) -> AssistantAnswer | None:
        item_id = self._item_id(answer_id)
        if item_id is not None:
            return self._by_item(session_id, answer_id, item_id)
        source_product_seq = self._sequence(answer_id)
        if source_product_seq is None:
            return None
        return self._by_seq(session_id, answer_id, source_product_seq)

    # -- Legacy answer:{seq} lookup, unchanged semantics --

    def _by_seq(
        self, session_id: str, answer_id: str, source_product_seq: int
    ) -> AssistantAnswer | None:
        timeline = self._events.answer_timeline(
            session_id,
            source_product_seq=source_product_seq,
        )
        if not timeline:
            return None
        anchor = timeline[0]
        if (
            anchor.product_seq != source_product_seq
            or anchor.kind != PRODUCT_EVENT_MESSAGE_DELTA
            or str(anchor.payload.get("phase") or "") != FINAL_ANSWER_PHASE
        ):
            return None
        deltas = tuple(
            event
            for event in timeline
            if event.kind == PRODUCT_EVENT_MESSAGE_DELTA
            and event.vendor_item_id == anchor.vendor_item_id
            and str(event.payload.get("phase") or "") == FINAL_ANSWER_PHASE
        )
        completed = next(
            (event for event in timeline if event.kind == PRODUCT_EVENT_TURN_COMPLETED),
            None,
        )
        if not deltas or completed is None:
            return None
        markdown = str(deltas[-1].payload.get("delta") or "")
        if not markdown:
            return None
        return AssistantAnswer(
            answer_id=answer_id,
            session_id=session_id,
            turn_id=str(anchor.vendor_turn_id or ""),
            source_product_seq=source_product_seq,
            vendor_item_id=anchor.vendor_item_id,
            markdown=markdown,
            revision=self._revision(markdown),
            completed_at=completed.created_at,
        )

    # -- New item:{vendor_item_id} lookup, supports agent/thinking/tool --

    def _by_item(
        self, session_id: str, answer_id: str, vendor_item_id: str
    ) -> AssistantAnswer | None:
        events = self._events.item_events(session_id, vendor_item_id=vendor_item_id)
        if not events:
            return None
        first = events[0]
        turn_id = first.vendor_turn_id or ""
        completed = self._events.turn_completed(session_id, vendor_turn_id=turn_id)
        if completed is None:
            return None
        markdown = self._reconstruct_markdown(events)
        if not markdown:
            return None
        return AssistantAnswer(
            answer_id=answer_id,
            session_id=session_id,
            turn_id=turn_id,
            source_product_seq=first.product_seq,
            vendor_item_id=vendor_item_id,
            markdown=markdown,
            revision=self._revision(markdown),
            completed_at=completed.created_at,
        )

    @staticmethod
    def _reconstruct_markdown(events: tuple[ProductEventRecord, ...]) -> str:
        # Assistant message_delta events (agent answers and commentary
        # "thinking") are cumulative snapshots — the final snapshot wins.
        # Reasoning deltas (silent chain-of-thought "thinking") store raw
        # increments (live.py publishes the raw delta only when
        # role=="reasoning"), so we concatenate them to mirror the transcript
        # accumulator on the client. Tool bodies are captured once at
        # tool_completed.output.
        message_deltas = [event for event in events if event.kind == PRODUCT_EVENT_MESSAGE_DELTA]
        if message_deltas:
            return str(message_deltas[-1].payload.get("delta") or "")
        reasoning_deltas = [
            event for event in events if event.kind == PRODUCT_EVENT_REASONING_DELTA
        ]
        if reasoning_deltas:
            return "".join(str(event.payload.get("delta") or "") for event in reasoning_deltas)
        tool_completed = next(
            (event for event in events if event.kind == PRODUCT_EVENT_TOOL_COMPLETED),
            None,
        )
        if tool_completed is not None:
            return str(tool_completed.payload.get("output") or "")
        # Tool still in-flight or unknown message shape: not annotatable.
        return ""

    @staticmethod
    def _revision(markdown: str) -> str:
        return f"{SHA256_REVISION_PREFIX}{hashlib.sha256(markdown.encode('utf-8')).hexdigest()}"

    @staticmethod
    def _sequence(answer_id: str) -> int | None:
        if not answer_id.startswith(ASSISTANT_ANSWER_ID_PREFIX):
            return None
        try:
            sequence = int(answer_id.removeprefix(ASSISTANT_ANSWER_ID_PREFIX))
        except ValueError:
            return None
        return sequence if sequence > 0 else None

    @staticmethod
    def _item_id(answer_id: str) -> str | None:
        if not answer_id.startswith(ITEM_MESSAGE_ID_PREFIX):
            return None
        item = answer_id.removeprefix(ITEM_MESSAGE_ID_PREFIX).strip()
        return item or None


__all__ = ["ITEM_MESSAGE_ID_PREFIX", "ProductAnswerSource"]

# `PRODUCT_EVENT_TOOL_STARTED` is imported to keep it in the module surface
# for any future path that must acknowledge in-flight tools; the guard against
# in-flight-only items is expressed via `_reconstruct_markdown` above.
_ = PRODUCT_EVENT_TOOL_STARTED
