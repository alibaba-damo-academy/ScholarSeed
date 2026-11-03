"""Current navigation for durable task reminders."""

from __future__ import annotations

from typing import Any

from service.chat.constants import (
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_SESSION_STATE_RUNNING,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
)
from service.chat.persistence.attention import (
    ATTENTION_RECOVERY,
    AttentionKind,
    AttentionStore,
    recovery_blocked,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal
from service.chat.persistence.events import ProductEventStore
from service.chat.service.sessions import SessionService

ATTENTION_NAVIGATION_KINDS = (
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
)
ATTENTION_NOT_FOUND = "attention_not_found"
HTTP_OK = 200
HTTP_NOT_FOUND = 404
ATTENTION_PROGRESS = "progress"
ATTENTION_FOCUS_KINDS = {
    PRODUCT_EVENT_TURN_COMPLETED: AttentionKind.COMPLETED.value,
    PRODUCT_EVENT_TURN_FAILED: AttentionKind.FAILED.value,
}


class AttentionService:
    def __init__(
        self,
        store: AttentionStore,
        catalog: SessionCatalogStore,
        events: ProductEventStore,
        sessions: SessionService,
    ) -> None:
        self.store = store
        self._catalog = catalog
        self._events = events
        self._sessions = sessions

    def navigation(self, identity: str, principal: SessionPrincipal) -> tuple[dict[str, Any], int]:
        reminder = self.store.get(principal, identity)
        if reminder is None:
            return {"error": ATTENTION_NOT_FOUND}, HTTP_NOT_FOUND
        session_id = reminder["session_id"]
        location, status = self._sessions.navigation(session_id, principal)
        if status != HTTP_OK:
            return location, status
        pending = self._catalog.pending_hil(session_id)
        settlement = self._catalog.pending_turn_settlement(session_id)
        if pending:
            selected = next(
                (
                    request
                    for request in pending
                    if request.product_request_id == reminder["request_id"]
                ),
                pending[-1],
            )
            focus = {
                "kind": AttentionKind.WAITING.value,
                "request_id": selected.product_request_id,
                "turn_id": selected.vendor_turn_id,
                "item_id": selected.vendor_item_id,
            }
        elif settlement and settlement.recovery_blocked:
            focus = {
                "kind": ATTENTION_RECOVERY,
                "request_id": None,
                "turn_id": settlement.native_turn_id,
                "item_id": None,
                "incident_id": self._events.recovery_snapshot(
                    session_id, settlement.native_turn_id
                )["recovery_incident_id"],
            }
        else:
            candidates = [
                record
                for kind in ATTENTION_NAVIGATION_KINDS
                if (record := self._events.latest_kind(session_id, kind)) is not None
                and (
                    kind != PRODUCT_EVENT_SESSION_STATE
                    or recovery_blocked(record.payload)
                    or (
                        record.payload.get("state") == PRODUCT_SESSION_STATE_RUNNING
                        and bool(record.payload.get("active_turn_id") or record.vendor_turn_id)
                    )
                )
                and (
                    kind != PRODUCT_EVENT_USER_MESSAGE
                    or record.payload.get("binding")
                    in {USER_MESSAGE_BINDING_ADMITTED, USER_MESSAGE_BINDING_BOUND}
                )
            ]
            latest = max(candidates, key=lambda record: record.product_seq, default=None)
            turn_id = (
                latest.vendor_turn_id
                or latest.payload.get("active_turn_id")
                or latest.payload.get("client_turn_id")
                if latest is not None
                else reminder["turn_id"]
            )
            kind = (
                ATTENTION_FOCUS_KINDS.get(latest.kind, ATTENTION_PROGRESS)
                if latest
                else ATTENTION_PROGRESS
            )
            if (
                latest
                and latest.kind == PRODUCT_EVENT_SESSION_STATE
                and recovery_blocked(latest.payload)
            ):
                kind = ATTENTION_RECOVERY
            message = (
                self._events.latest_answer(session_id, str(turn_id))
                if turn_id and kind == AttentionKind.COMPLETED.value
                else None
            )
            focus = {
                "kind": kind,
                "incident_id": (
                    str(latest.payload.get("incident_id") or turn_id)
                    if latest and kind == ATTENTION_RECOVERY
                    else None
                ),
                "request_id": None,
                "turn_id": turn_id or None,
                "item_id": message.vendor_item_id if message else None,
            }
        return {**location, "focus": focus}, HTTP_OK
