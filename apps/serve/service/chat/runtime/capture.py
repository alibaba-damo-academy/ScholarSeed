"""Consent-scoped selection of public observations, never vendor log scraping."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from damoatrace.data.store import TraceStore
from damoatrace.recording.content import (
    BLOCK_LIMIT,
    BUDGET_EXHAUSTED,
    CONTENT_FIELDS,
    CONTENT_VERSION,
    SESSION_LIMIT,
    TURN_LIMIT,
    ContentCategory,
    content_block,
)
from damoatrace.recording.redaction import Redactor
from scholarseed_runtime.contract.content import CONTENT_OBSERVATIONS
from scholarseed_runtime.contract.event import RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.input import InputKind, TurnInput
from service.chat.constants import PRODUCT_EVENT_HIL_REQUESTED, PRODUCT_EVENT_HIL_RESOLVED
from service.chat.persistence.events import ProductEventRecord
from service.chat.service.recording import RecordingPolicy, RecordingService

OBSERVATION_SOURCE = "runtime_observation"
ASSISTANT_ROLE = "assistant"
PERMISSION_FIELDS = frozenset(
    {
        "request_id",
        "kind",
        "body",
        "command",
        "cwd",
        "path",
        "diff",
        "changes",
        "questions",
        "requested_permissions",
        "permissions",
        "option_id",
        "answer",
    }
)
TERMINALS = frozenset(
    {
        RuntimeEventKind.TURN_COMPLETED,
        RuntimeEventKind.TURN_FAILED,
        RuntimeEventKind.TURN_INTERRUPTED,
        RuntimeEventKind.TURN_UNKNOWN,
        RuntimeEventKind.SESSION_CLOSED,
    }
)


class SessionCapture:
    def __init__(
        self,
        session_id: str,
        path: Path,
        policies: RecordingService,
        *,
        secrets: tuple[str, ...] = (),
    ) -> None:
        self.session_id = session_id
        self.path = path
        self.policies = policies
        self.redactor = Redactor(secrets)
        self.frozen = RecordingPolicy()
        self.submission = ""
        self.turn_bytes = 0
        self.session_bytes = 0
        self.seen: set[tuple[str, str]] = set()
        self.fragments: dict[str, str] = {}
        self.fragment_overflow: set[str] = set()
        self.policies.bind(session_id, self.invalidate)

    def invalidate(self) -> None:
        self.fragments.clear()
        self.fragment_overflow.clear()
        self.frozen = RecordingPolicy()

    def close(self) -> None:
        self.invalidate()
        self.policies.unbind(self.session_id)

    def allowed(self) -> bool:
        current = self.policies.current(self.session_id)
        permitted = (
            self.frozen.active and current.active and current.revision == self.frozen.revision
        )
        if not permitted:
            self.fragments.clear()
            self.fragment_overflow.clear()
        return permitted

    def block(
        self,
        category: ContentCategory,
        value: Any,
        *,
        source: str,
        missing_reason: str = "",
        observation: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        remaining = min(TURN_LIMIT - self.turn_bytes, SESSION_LIMIT - self.session_bytes)
        block = content_block(
            category,
            value,
            source=source,
            revision=self.frozen.revision,
            redactor=self.redactor,
            missing_reason=missing_reason,
            budget=remaining,
        )
        if block["truncated"] and remaining < BLOCK_LIMIT:
            block["missing_reason"] = BUDGET_EXHAUSTED
        self.turn_bytes += block["captured_bytes"]
        self.session_bytes += block["captured_bytes"]
        if observation and observation.get("truncated"):
            block["truncated"] = True
            block["original_bytes"] = observation.get("original_bytes")
            block["missing_reason"] = observation.get("missing_reason") or "upstream_truncated"
        if not block["captured_bytes"]:
            block.pop("data", None)
            block["missing_reason"] = BUDGET_EXHAUSTED
        return block

    def input(
        self,
        turn_input: TurnInput,
        *,
        user_text: str,
        context: str,
        context_identity: Mapping[str, Any],
        steer: bool,
    ) -> dict[str, Any] | None:
        if not steer:
            self.frozen = self.policies.current(self.session_id)
            self.submission = turn_input.client_user_message_id
            self.turn_bytes = 0
            self.fragments.clear()
            self.seen.clear()
            if self.frozen.active:
                store = TraceStore(
                    self.path.parent, trace_file=self.path, offline=True, include_content=True
                )
                self.session_bytes = sum(
                    int(block.get("captured_bytes", 0))
                    for event in store.all_events()
                    for field in CONTENT_FIELDS
                    for block in (
                        event[field].get("blocks", []) if isinstance(event.get(field), dict) else []
                    )
                    if "data" in block
                )
        if not self.allowed():
            return None
        submitted = [
            {
                "kind": item.kind.value,
                **(
                    {"text": item.text}
                    if item.kind == InputKind.TEXT
                    else {"name": item.name, "binary_body": "not_captured"}
                ),
            }
            for item in turn_input.items
        ]
        blocks = [
            self.block(ContentCategory.USER, user_text, source="user_message"),
            self.block(
                ContentCategory.CONTEXT,
                {"text": context, **context_identity},
                source="product_context",
            ),
            self.block(ContentCategory.SUBMISSION, submitted, source="runtime_submission"),
        ]
        return {"version": CONTENT_VERSION, "blocks": blocks}

    def event(self, event: RuntimeEvent) -> tuple[dict | None, dict | None]:
        if not self.allowed():
            return None, None
        payload = event.payload if isinstance(event.payload, Mapping) else {}
        raw_observations = payload.get(CONTENT_OBSERVATIONS, [])
        if not isinstance(raw_observations, list):
            raw_observations = []
        observations = {
            observation.get("field"): observation
            for observation in raw_observations
            if isinstance(observation, dict)
        }
        key = (event.kind.value, event.native_item_id or event.event_id)
        if event.kind != RuntimeEventKind.CONTENT_DELTA and key in self.seen:
            return None, None
        incoming: list[dict] = []
        outgoing: list[dict] = []
        role = payload.get("role")
        if event.kind == RuntimeEventKind.CONTENT_DELTA and role == ASSISTANT_ROLE:
            # Reassemble before redaction; incomplete observations are never called full text.
            previous = self.fragments.get(event.native_item_id, "")
            fragment = str(payload.get("text") or "")
            if event.native_item_id not in self.fragment_overflow:
                if (
                    sum(len(s.encode()) for s in self.fragments.values()) + len(fragment.encode())
                    <= BLOCK_LIMIT
                ):
                    self.fragments[event.native_item_id] = previous + fragment
                else:
                    # Never retain a raw prefix that may end halfway through a credential.
                    self.fragments[event.native_item_id] = ""
                    self.fragment_overflow.add(event.native_item_id)
        elif event.kind == RuntimeEventKind.CONTENT_COMPLETED and role == ASSISTANT_ROLE:
            self.fragments.pop(event.native_item_id, None)
            self.fragment_overflow.discard(event.native_item_id)
            outgoing.append(
                self.block(
                    ContentCategory.ANSWER,
                    payload.get("text"),
                    source=OBSERVATION_SOURCE,
                    observation=observations.get("text"),
                    missing_reason="upstream_unavailable" if payload.get("text") is None else "",
                )
            )
        elif event.kind == RuntimeEventKind.TOOL_STARTED or "input" in observations:
            incoming.append(
                self.block(
                    ContentCategory.TOOL_INPUT,
                    payload.get("input"),
                    source=OBSERVATION_SOURCE,
                    observation=observations.get("input"),
                    missing_reason="upstream_unavailable" if "input" not in payload else "",
                )
            )
        elif event.kind == RuntimeEventKind.TOOL_COMPLETED or "output" in observations:
            outgoing.append(
                self.block(
                    ContentCategory.TOOL_OUTPUT,
                    payload.get("output"),
                    source=OBSERVATION_SOURCE,
                    observation=observations.get("output"),
                    missing_reason="upstream_unavailable" if "output" not in payload else "",
                )
            )
        if event.kind in TERMINALS:
            outgoing.extend(self.finish())
        if incoming or outgoing:
            self.seen.add(key)
        return (
            {"version": CONTENT_VERSION, "blocks": incoming} if incoming else None,
            {"version": CONTENT_VERSION, "blocks": outgoing} if outgoing else None,
        )

    def finish(self) -> list[dict[str, Any]]:
        """Flush only authorized incomplete public output, including disconnects."""
        if not self.allowed():
            return []
        blocks = []
        for item_id, fragment in self.fragments.items():
            block = self.block(
                ContentCategory.ANSWER,
                fragment,
                source=OBSERVATION_SOURCE,
                missing_reason="interrupted",
            )
            block["native_item_id"] = item_id
            block["truncated"] = True
            block["original_bytes"] = None
            if item_id in self.fragment_overflow:
                block.pop("data", None)
                block["missing_reason"] = "unsafe_partial_omitted"
            blocks.append(block)
        self.fragments.clear()
        self.fragment_overflow.clear()
        return blocks

    def product(self, record: ProductEventRecord) -> dict | None:
        if (
            record.kind not in {PRODUCT_EVENT_HIL_REQUESTED, PRODUCT_EVENT_HIL_RESOLVED}
            or not self.allowed()
        ):
            return None
        selected = {key: value for key, value in record.payload.items() if key in PERMISSION_FIELDS}
        return {
            "version": CONTENT_VERSION,
            "blocks": [
                self.block(ContentCategory.PERMISSION, selected, source="product_permission")
            ],
        }
