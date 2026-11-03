"""Bounded, explicitly lossy drafts from product-owned visible messages."""

from __future__ import annotations

import json
from typing import Any

from scholarseed_runtime.contract.history import MessagePhase
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
    USER_MESSAGE_BINDING_CANCELLED,
    USER_MESSAGE_ORIGIN_TURN,
)
from service.chat.persistence.catalog import SessionCatalogRecord
from service.chat.persistence.events import ProductEventRecord

CONTINUATION_MAX_MESSAGES = 30
CONTINUATION_MAX_CHARACTERS = 24_000
CONTINUATION_MAX_BYTES = 96 * 1024
CONTINUATION_MAX_SOURCE_EVENTS = 20_000
CONTINUATION_MAX_SOURCE_BYTES = 8 * 1024 * 1024
CONTINUATION_GOAL_BUDGET_DIVISOR = 4
CONTINUATION_BUSY = "session_continuation_busy"
CONTINUATION_STALE = "session_continuation_stale"
CONTINUATION_UNAVAILABLE = "session_continuation_unavailable"
CONTINUATION_MODEL_UNAVAILABLE = "session_continuation_model_unavailable"
CONTINUATION_EXCLUDED_CATEGORIES = (
    "reasoning",
    "encrypted_content",
    "tool_outputs",
    "attachments",
    "subagent_state",
    "approvals",
    "queued_messages",
    "cancelled_messages",
    "internal_recovery_messages",
    "incomplete_assistant_messages",
    "assistant_commentary",
)


def continuation_snapshot(
    source: SessionCatalogRecord,
    model_id: str,
    records: tuple[ProductEventRecord, ...],
) -> dict[str, Any]:
    completed = {
        (record.vendor_thread_id, record.vendor_turn_id)
        for record in records
        if record.kind == PRODUCT_EVENT_TURN_COMPLETED and record.vendor_turn_id
    }
    projected: dict[tuple[str, ...], tuple[int, str, str]] = {}
    identity: tuple[str, ...]
    for record in records:
        body = record.payload
        if record.kind == PRODUCT_EVENT_USER_MESSAGE:
            if body.get("origin", USER_MESSAGE_ORIGIN_TURN) != USER_MESSAGE_ORIGIN_TURN:
                continue
            role = "user"
            text = body.get("text")
            identity = (
                role,
                str(body.get("client_turn_id") or record.vendor_item_id or record.product_seq),
            )
            if body.get("binding") == USER_MESSAGE_BINDING_CANCELLED:
                projected.pop(identity, None)
                continue
        elif record.kind == PRODUCT_EVENT_MESSAGE_DELTA:
            if (
                (record.vendor_thread_id, record.vendor_turn_id) not in completed
                or body.get("phase") not in {None, "", MessagePhase.FINAL_ANSWER.value}
                or body.get("role", "assistant") != "assistant"
            ):
                continue
            role = "assistant"
            text = body.get("delta")
            identity = (
                role,
                record.vendor_thread_id,
                str(record.vendor_turn_id),
                str(record.vendor_item_id or record.vendor_turn_id),
            )
        else:
            continue
        if not isinstance(text, str):
            continue
        text = text.strip()
        existing = projected.get(identity)
        if not text:
            projected.pop(identity, None)
            continue
        projected[identity] = (
            existing[0] if existing is not None else record.product_seq,
            role,
            text,
        )
    messages = sorted(projected.values(), key=lambda message: message[0])
    if not messages:
        raise ValueError(CONTINUATION_UNAVAILABLE)
    total_characters = sum(len(message[2]) for message in messages)
    retained: dict[int, dict[str, str]] = {}

    def payload() -> dict[str, Any]:
        selected = [retained[sequence] for sequence in sorted(retained)]
        omitted_characters = total_characters - sum(len(message["text"]) for message in selected)
        return {
            "source_session_id": source.session_id,
            "source_product_seq": source.last_product_seq,
            "source_title": source.title,
            "project_path": source.project_path,
            "model_id": model_id,
            "messages": selected,
            "included_messages": len(selected),
            "omitted_messages": len(messages) - len(selected),
            "omitted_characters": omitted_characters,
            "truncated": bool(omitted_characters or len(messages) != len(selected)),
            "excluded_categories": list(CONTINUATION_EXCLUDED_CATEGORIES),
        }

    def wire_size() -> int:
        return len(json.dumps(payload(), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    if wire_size() > CONTINUATION_MAX_BYTES:
        raise ValueError(CONTINUATION_UNAVAILABLE)
    goal = next((message for message in messages if message[1] == "user"), None)
    candidates = ([goal] if goal is not None else []) + [
        message for message in reversed(messages) if message is not goal
    ]
    remaining = CONTINUATION_MAX_CHARACTERS
    for sequence, role, text in candidates:
        if len(retained) >= CONTINUATION_MAX_MESSAGES or remaining <= 0:
            break
        maximum = min(len(text), remaining)
        if goal is not None and sequence == goal[0] and len(messages) > 1:
            maximum = min(maximum, CONTINUATION_MAX_CHARACTERS // CONTINUATION_GOAL_BUDGET_DIVISOR)
        lower = 0
        upper = maximum
        while lower < upper:
            midpoint = (lower + upper + 1) // 2
            retained[sequence] = {"role": role, "text": text[:midpoint]}
            if wire_size() <= CONTINUATION_MAX_BYTES:
                lower = midpoint
            else:
                upper = midpoint - 1
        if lower:
            retained[sequence] = {"role": role, "text": text[:lower]}
            remaining -= lower
        else:
            retained.pop(sequence, None)
    result = payload()
    if not retained or wire_size() > CONTINUATION_MAX_BYTES:
        raise ValueError(CONTINUATION_UNAVAILABLE)
    return result
