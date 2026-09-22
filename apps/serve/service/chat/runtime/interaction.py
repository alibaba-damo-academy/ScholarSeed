"""Product approval delivery, serialization and uncertainty ledger."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Mapping, Protocol

from scholarseed_runtime.contract import CommandState, RuntimeCallbackResponse, RuntimeSession
from scholarseed_runtime.contract.incident import RuntimeRetryability
from service.chat.constants import (
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_OPERATION_STATE,
    PRODUCT_SESSION_STATE_RUNNING,
    PRODUCT_SESSION_STATE_WAITING,
)
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionHilRecord,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventRecord
from service.chat.runtime.projection import INTERNAL_EVENT_KEY_PREFIX

USER_INPUT_METHOD = "user_input"
PRODUCT_USER_INPUT_METHOD = "product_user_input"
PRODUCT_INTERACTION_CANCELLED = "product_interaction_cancelled"


def interaction_snapshot(record: SessionHilRecord) -> dict[str, Any]:
    """Serialize one callback without exposing vendor-only response details."""

    decision = dict(record.decision or {})
    raw_answers = decision.get("answers")
    answers = (
        {str(key): str(value) for key, value in raw_answers.items()}
        if isinstance(raw_answers, Mapping)
        else {}
    )
    state = record.status.value
    if bool(decision.get("cancelled")):
        state = "cancelled"
    return {
        "session_id": record.session_id,
        "request_id": record.product_request_id,
        "turn_id": record.vendor_turn_id,
        "item_id": record.vendor_item_id,
        **record.payload,
        "state": state,
        "answers": answers,
        "created_at": record.created_at,
        "resolved_at": record.resolved_at,
    }


class ProductPublisher(Protocol):
    async def __call__(
        self,
        kind: str,
        data: Mapping[str, Any],
        *,
        turn_id: str = "",
        item_id: str = "",
        idempotency_key: str = "",
    ) -> ProductEventRecord: ...


class SessionInteractions:
    def __init__(
        self, session_id: str, catalog: SessionCatalogStore, publish: ProductPublisher
    ) -> None:
        self._session_id = session_id
        self._catalog = catalog
        self._publish = publish
        self._lock = asyncio.Lock()
        self._product_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}

    async def request_product_input(
        self,
        question: Mapping[str, Any],
        *,
        turn_id: str,
        item_id: str = "",
    ) -> dict[str, Any]:
        """Publish and wait for a product-owned question without routing through Runtime."""

        request_id = str(question.get("id") or "").strip()
        if not request_id or not turn_id.strip():
            raise ValueError("product interaction identity is unavailable")
        payload = {
            "request_id": request_id,
            "kind": "question",
            "method": USER_INPUT_METHOD,
            "questions": [dict(question)],
        }
        loop = asyncio.get_running_loop()
        async with self._lock:
            if request_id in self._product_waiters:
                raise RuntimeError("product interaction is already waiting")
            waiter: asyncio.Future[dict[str, Any]] = loop.create_future()
            self._product_waiters[request_id] = waiter
            self._catalog.record_hil(
                product_request_id=request_id,
                session_id=self._session_id,
                vendor_request_id=request_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id or None,
                method=PRODUCT_USER_INPUT_METHOD,
                payload=payload,
            )
            self._catalog.update_status(
                self._session_id,
                SessionStatus.WAITING_HIL,
                turn_id=turn_id,
                turn_status=PRODUCT_SESSION_STATE_WAITING,
            )
            await self._publish(
                PRODUCT_EVENT_HIL_REQUESTED,
                payload,
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=f"product:callback:{request_id}",
            )
        try:
            return await waiter
        finally:
            self._product_waiters.pop(request_id, None)

    def is_product_request(self, request_id: str) -> bool:
        try:
            return self._catalog.hil(request_id).method == PRODUCT_USER_INPUT_METHOD
        except SessionAccessError:
            return False

    async def cancel_product_requests(self) -> None:
        """Resolve active product waiters as cancelled before their owning turn closes."""

        async with self._lock:
            for request_id, waiter in tuple(self._product_waiters.items()):
                if waiter.done():
                    continue
                record = self._catalog.hil(request_id)
                decision = {"cancelled": True, "reason": PRODUCT_INTERACTION_CANCELLED}
                if not self._catalog.resolve_hil(request_id, decision):
                    continue
                resolved = interaction_snapshot(self._catalog.hil(request_id))
                await self._publish(
                    PRODUCT_EVENT_HIL_RESOLVED,
                    resolved,
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                    idempotency_key=f"product:callback:{request_id}:cancelled",
                )
                waiter.set_result(decision)

    @staticmethod
    def _safe_uncertainty_card(payload: Mapping[str, Any]) -> dict[str, Any]:
        safe_keys = (
            "request_id",
            "kind",
            "trigger",
            "method",
            "tool_name",
            "runtime_tool_name",
            "title",
            "body",
            "network_target",
            "permissions",
            "safety_tags",
            "options",
        )
        return {name: payload[name] for name in safe_keys if name in payload}

    async def resolve(
        self, runtime_session: RuntimeSession | None, request_id: str, response: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        async with self._lock:
            pending = {
                row.product_request_id: row for row in self._catalog.pending_hil(self._session_id)
            }
            record = pending.get(request_id)
            if record is None:
                return None
            decision = dict(response)
            if record.method == PRODUCT_USER_INPUT_METHOD:
                waiter = self._product_waiters.get(request_id)
                if waiter is None or not self._catalog.resolve_hil(request_id, decision):
                    return None
                self._catalog.update_status(
                    self._session_id,
                    SessionStatus.RUNNING,
                    turn_id=record.vendor_turn_id or "",
                    turn_status=PRODUCT_SESSION_STATE_RUNNING,
                )
                resolved = interaction_snapshot(self._catalog.hil(request_id))
                await self._publish(
                    PRODUCT_EVENT_HIL_RESOLVED,
                    resolved,
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                    idempotency_key=f"product:callback:{request_id}:resolved",
                )
                waiter.set_result(decision)
                return resolved
            if runtime_session is None:
                raise RuntimeError("runtime session is unavailable")
            if not self._catalog.seal_hil_uncertainty(
                request_id,
                decision,
                UncertaintyKind.HIL_RESPONSE,
                payload={
                    "execution_count": 0,
                    "turn_id": record.vendor_turn_id or "",
                    "item_id": record.vendor_item_id or "",
                    "card": self._safe_uncertainty_card(record.payload),
                },
            ):
                return None
            try:
                if runtime_session is not None:
                    receipt = await runtime_session.respond(
                        RuntimeCallbackResponse(
                            request_id=request_id,
                            decision=str(decision.get("decision") or ""),
                            values=decision,
                            idempotency_key=request_id,
                            responded_at=str(time.time()),
                        )
                    )
                    accepted = receipt.state in {
                        CommandState.ACCEPTED,
                        CommandState.APPLIED,
                    }
            except Exception as exc:  # noqa: BLE001 - delivery outcome is typed below
                await self._mark_delivery_uncertain(
                    UncertaintyKind.HIL_RESPONSE,
                    request_id,
                    exc,
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                )
                return None
            if not accepted:
                self._catalog.stale_hil(request_id)
                await self._mark_delivery_stale(
                    UncertaintyKind.HIL_RESPONSE,
                    request_id,
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                )
                return None
            self._catalog.resolve_hil(request_id, decision)
            self._catalog.transition_uncertainty(
                self._session_id,
                UncertaintyKind.HIL_RESPONSE,
                request_id,
                UncertaintyState.RECONCILED,
            )
            self._catalog.update_status(
                self._session_id,
                SessionStatus.RUNNING,
                turn_id=record.vendor_turn_id or "",
                turn_status=PRODUCT_SESSION_STATE_RUNNING,
            )
            return interaction_snapshot(self._catalog.hil(request_id))

    async def _mark_delivery_uncertain(
        self,
        kind: UncertaintyKind,
        request_id: str,
        error: Exception,
        *,
        turn_id: str,
        item_id: str,
    ) -> None:
        retryability = getattr(error, "retryability", None)
        retryability_value = str(getattr(retryability, "value", retryability) or "")
        state = (
            UncertaintyState.UNKNOWN
            if retryability_value == RuntimeRetryability.UNKNOWN_OUTCOME.value
            else UncertaintyState.STALE
        )
        row = self._catalog.uncertainty(self._session_id, kind, request_id)
        current_payload = dict(row.payload) if row else {}
        execution_count = int(current_payload.get("execution_count", 0) or 0)
        self._catalog.transition_uncertainty(
            self._session_id,
            kind,
            request_id,
            state,
            payload={**current_payload, "execution_count": execution_count},
        )
        if state == UncertaintyState.STALE:
            self._catalog.stale_hil(request_id)
        await self._publish_operation_state(
            kind, request_id, state, execution_count, turn_id, item_id
        )

    async def _mark_delivery_stale(
        self,
        kind: UncertaintyKind,
        request_id: str,
        *,
        turn_id: str,
        item_id: str,
    ) -> None:
        row = self._catalog.uncertainty(self._session_id, kind, request_id)
        current_payload = dict(row.payload) if row else {}
        execution_count = int(current_payload.get("execution_count", 0) or 0)
        self._catalog.transition_uncertainty(
            self._session_id,
            kind,
            request_id,
            UncertaintyState.STALE,
            payload={**current_payload, "execution_count": execution_count},
        )
        await self._publish_operation_state(
            kind,
            request_id,
            UncertaintyState.STALE,
            execution_count,
            turn_id,
            item_id,
        )

    async def _publish_operation_state(
        self,
        kind: UncertaintyKind,
        request_id: str,
        state: UncertaintyState,
        execution_count: int,
        turn_id: str,
        item_id: str,
    ) -> None:
        await self._publish(
            PRODUCT_EVENT_OPERATION_STATE,
            {
                "kind": kind.value,
                "correlation_id": request_id,
                "state": state.value,
                "retryable": False,
                "execution_count": execution_count,
            },
            turn_id=turn_id,
            item_id=item_id,
            idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:operation:{kind.value}:{request_id}:{state.value}",
        )
