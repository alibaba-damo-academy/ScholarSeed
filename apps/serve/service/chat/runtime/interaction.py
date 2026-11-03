"""Product approval delivery, serialization and uncertainty ledger."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import math
import time
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import unquote, urlsplit

from scholarseed_runtime.contract import CommandState, RuntimeCallbackResponse, RuntimeSession
from scholarseed_runtime.contract.incident import RuntimeRetryability
from service.chat.constants import (
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_OPERATION_STATE,
    PRODUCT_INTERACTION_BLOCKING,
    PRODUCT_SESSION_STATE_RUNNING,
    PRODUCT_SESSION_STATE_WAITING,
)
from service.chat.persistence.catalog import (
    HilStatus,
    SessionAccessError,
    SessionCatalogStore,
    SessionHilRecord,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.runtime.projection import INTERNAL_EVENT_KEY_PREFIX, TERMINAL_TURN_OUTCOMES
from service.platform.activity import ActivityLease
from service.platform.bridge import (
    BROWSER_HISTORY_LIMIT_MAX,
    BROWSER_HISTORY_OFFSET_MAX,
    BROWSER_HISTORY_SEARCH_CHARS,
    BROWSER_INTENT_CHARS,
)

USER_INPUT_METHOD = "user_input"
PRODUCT_USER_INPUT_METHOD = "product_user_input"
PRODUCT_INTERACTION_CANCELLED = "product_interaction_cancelled"
PRODUCT_INTERACTION_LIFETIME = "session"
PRODUCT_INTERACTION_TIMED_OUT = "timed_out"
PRODUCT_INTERACTION_TIMEOUT = "timeout_seconds"
BROWSER_APPROVAL_METHOD = "browser_approval"
BROWSER_APPROVAL_KIND = "browser_approval"
BROWSER_HISTORY_APPROVAL_METHOD = "browser_history_approval"
BROWSER_HISTORY_APPROVAL_KIND = "browser_history_approval"
BROWSER_APPROVAL_DECISIONS = frozenset(("deny", "allow_once"))
BROWSER_APPROVAL_SCOPE_FIELDS = frozenset(
    (
        "session_id",
        "instance_id",
        "product_turn_id",
        "turn_id",
        "generation",
        "interrupt_generation",
        "lifecycle_epoch",
    )
)
BROWSER_APPROVAL_PROOF_CHARS = 128
BROWSER_NAVIGATE_URL_CHARS = 8192
BROWSER_APPROVAL_EXPIRED = "expired"
BROWSER_APPROVAL_BROADCAST_FAILED = "broadcast_failed"
BROWSER_APPROVAL_LOGGER = logging.getLogger(__name__)


def _browser_origin(value: str) -> str | None:
    if not isinstance(value, str) or len(value) > BROWSER_NAVIGATE_URL_CHARS:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        host = parsed.hostname
        if ":" in host:
            host = f"[{ipaddress.IPv6Address(host).compressed}]"
        if parsed.port is not None and parsed.port != (443 if parsed.scheme == "https" else 80):
            host = f"{host}:{parsed.port}"
        origin = f"{parsed.scheme}://{host}"
        return origin if parsed.netloc == origin.split("://", 1)[1] else None
    except (ValueError, TypeError):
        return None


def _valid_browser_navigate(
    origin: str,
    source_origin: str | None,
    destination_url: str | None,
    destination_origin: str | None,
) -> bool:
    if source_origin is not None and _browser_origin(source_origin) != source_origin:
        return False
    if (
        not isinstance(destination_origin, str)
        or _browser_origin(destination_origin) != destination_origin
    ):
        return False
    if origin != destination_origin or not isinstance(destination_url, str):
        return False
    if not 1 <= len(destination_url) <= BROWSER_NAVIGATE_URL_CHARS or not destination_url.isascii():
        return False
    if any(ord(character) <= 32 or character == "\\" for character in destination_url):
        return False
    if any(
        destination_url[index] == "%"
        and (
            index + 2 >= len(destination_url)
            or not all(
                character in "0123456789abcdefABCDEF"
                for character in destination_url[index + 1 : index + 3]
            )
        )
        for index in range(len(destination_url))
    ):
        return False
    try:
        parsed = urlsplit(destination_url)
    except ValueError:
        return False
    if not destination_url.startswith(f"{parsed.scheme}://"):
        return False
    if _browser_origin(destination_url) != destination_origin or not parsed.path.startswith("/"):
        return False
    return not any(unquote(segment).lower() in {".", ".."} for segment in parsed.path.split("/"))


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
    snapshot = {
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
    if record.method in {BROWSER_APPROVAL_METHOD, BROWSER_HISTORY_APPROVAL_METHOD}:
        snapshot["decision"] = str(decision.get("decision") or "")
        snapshot["reason"] = str(decision.get("reason") or "")
    return snapshot


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
        self,
        session_id: str,
        catalog: SessionCatalogStore,
        publish: ProductPublisher,
        *,
        events: ProductEventStore | None = None,
        broadcast: Callable[[ProductEventRecord], None] | None = None,
        bind_component: Callable[[Mapping[str, Any]], None] | None = None,
        finish_component: Callable[[Mapping[str, Any]], None] | None = None,
    ) -> None:
        self._session_id = session_id
        self._catalog = catalog
        self._publish = publish
        self._lock = asyncio.Lock()
        self._product_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._product_activities: dict[str, ActivityLease] = {}
        self._browser_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._events = events
        self._broadcast = broadcast
        self._bind_component = bind_component
        self._finish_component = finish_component

    def _finish_components(self, record: SessionHilRecord) -> None:
        if self._finish_component is not None:
            for question in record.payload.get("questions", []):
                if isinstance(question, Mapping):
                    self._finish_component(question)

    def _broadcast_browser(self, record: ProductEventRecord) -> bool:
        if self._broadcast is None:
            return False
        try:
            self._broadcast(record)
        except Exception as error:  # noqa: BLE001 - durable event is still replayable
            BROWSER_APPROVAL_LOGGER.warning(
                "browser_approval_broadcast_failed",
                extra={
                    "session_id": self._session_id,
                    "request_id": record.payload.get("request_id"),
                    "event_kind": record.kind,
                    "error_type": type(error).__name__,
                },
            )
            return False
        return True

    async def request_browser_approval(
        self,
        *,
        request_id: str,
        proof_id: str | None = None,
        turn_id: str,
        runtime_id: str,
        vendor_thread_id: str,
        tab_id: str,
        target_instance_id: str,
        target_generation: int,
        origin: str,
        action: str,
        intent: str,
        expires_at: float,
        scope: Mapping[str, object] | None = None,
        source_origin: str | None = None,
        destination_url: str | None = None,
        destination_origin: str | None = None,
        prepared_id: str | None = None,
        snapshot_id: str | None = None,
        element_ref: str | None = None,
        browser_action: str | None = None,
        element: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        if self._events is None or self._broadcast is None:
            raise RuntimeError("browser approval is unavailable")
        if (
            not all(
                (
                    request_id,
                    turn_id,
                    runtime_id,
                    vendor_thread_id,
                    tab_id,
                    target_instance_id,
                    origin,
                    action,
                )
            )
            or isinstance(target_generation, bool)
            or not isinstance(target_generation, int)
            or target_generation < 0
        ):
            raise ValueError("browser approval identity is unavailable")
        if expires_at <= time.time():
            return {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED}
        if proof_id is not None and (
            not isinstance(proof_id, str) or not 1 <= len(proof_id) <= BROWSER_APPROVAL_PROOF_CHARS
        ):
            raise ValueError("browser approval proof invalid")
        if action == "navigate":
            if not proof_id or not _valid_browser_navigate(
                origin, source_origin, destination_url, destination_origin
            ):
                raise ValueError("browser navigate approval destination invalid")
        if action in {"click", "fill", "submit"}:
            if (
                not proof_id
                or not all(
                    isinstance(item, str) and 1 <= len(item) <= BROWSER_APPROVAL_PROOF_CHARS
                    for item in (prepared_id, snapshot_id, element_ref)
                )
                or browser_action not in {"click", "fill", "submit"}
                or action != browser_action
                or element is None
                or set(element) != {"role", "name"}
                or any(not isinstance(item, str) for item in element.values())
            ):
                raise ValueError("browser action approval proof invalid")
        if scope is not None:
            if (
                frozenset(scope) != BROWSER_APPROVAL_SCOPE_FIELDS
                or scope["session_id"] != self._session_id
                or scope["turn_id"] != turn_id
                or not all(
                    isinstance(scope[field], str) and scope[field]
                    for field in ("instance_id", "product_turn_id")
                )
                or not all(
                    isinstance(value, int)
                    and not isinstance(value, bool)
                    and value >= (0 if field == "interrupt_generation" else 1)
                    for field in ("generation", "interrupt_generation", "lifecycle_epoch")
                    for value in (scope[field],)
                )
            ):
                raise ValueError("browser approval scope invalid")
        payload = {
            "request_id": request_id,
            **({"proof_id": proof_id} if proof_id is not None else {}),
            "kind": BROWSER_APPROVAL_KIND,
            "method": BROWSER_APPROVAL_METHOD,
            "tab_id": tab_id,
            "target_instance_id": target_instance_id,
            "target_generation": target_generation,
            "origin": origin,
            "action": action,
            "intent": intent,
            "expires_at": expires_at,
            **(
                {
                    "source_origin": source_origin,
                    "destination_url": destination_url,
                    "destination_origin": destination_origin,
                }
                if action == "navigate"
                else {}
            ),
            **(
                {
                    "prepared_id": prepared_id,
                    "snapshot_id": snapshot_id,
                    "element_ref": element_ref,
                    "browser_action": browser_action,
                    "element": dict(element) if element is not None else {},
                }
                if action in {"click", "fill", "submit"}
                else {}
            ),
            **(
                {
                    field: scope[field]
                    for field in BROWSER_APPROVAL_SCOPE_FIELDS - {"session_id", "turn_id"}
                }
                if scope is not None
                else {}
            ),
        }
        loop = asyncio.get_running_loop()
        async with self._lock:
            if request_id in self._browser_waiters:
                raise RuntimeError("browser approval is already waiting")
            with self._events.transaction() as connection:
                self._catalog.record_browser_hil(
                    connection=connection,
                    request_id=request_id,
                    session_id=self._session_id,
                    turn_id=turn_id,
                    payload=payload,
                    method=BROWSER_APPROVAL_METHOD,
                )
                requested = self._events.append(
                    session_id=self._session_id,
                    runtime_id=runtime_id,
                    vendor_thread_id=vendor_thread_id,
                    vendor_turn_id=turn_id,
                    vendor_item_id=None,
                    kind=PRODUCT_EVENT_HIL_REQUESTED,
                    payload=payload,
                    idempotency_key=f"browser:approval:{request_id}:requested",
                    connection=connection,
                )
            waiter: asyncio.Future[dict[str, Any]] = loop.create_future()
            self._browser_waiters[request_id] = waiter
            published = self._broadcast_browser(requested)
        try:
            if not published:
                denial = {"decision": "deny", "reason": BROWSER_APPROVAL_BROADCAST_FAILED}
                await self._resolve_browser(request_id, denial, turn_id=turn_id)
                return denial
            async with asyncio.timeout_at(loop.time() + max(0, expires_at - time.time())):
                return await asyncio.shield(waiter)
        except TimeoutError:
            await self._resolve_browser(
                request_id,
                {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED},
                turn_id=turn_id,
            )
            return {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED}
        except asyncio.CancelledError:
            await self._resolve_browser(
                request_id,
                {"decision": "deny", "reason": PRODUCT_INTERACTION_CANCELLED},
                turn_id=turn_id,
            )
            raise
        finally:
            self._browser_waiters.pop(request_id, None)

    async def request_browser_history_approval(
        self,
        *,
        request_id: str,
        proof_id: str,
        turn_id: str,
        runtime_id: str,
        vendor_thread_id: str,
        search: str,
        offset: int,
        limit: int,
        intent: str,
        query_digest: str,
        history_revision: int,
        expires_at: float,
        scope: Mapping[str, object],
    ) -> dict[str, Any]:
        if self._events is None or self._broadcast is None:
            raise RuntimeError("browser history approval is unavailable")
        if (
            not all((request_id, proof_id, turn_id, runtime_id, vendor_thread_id, search, intent))
            or not 1 <= len(proof_id) <= BROWSER_APPROVAL_PROOF_CHARS
            or not 1 <= len(search) <= BROWSER_HISTORY_SEARCH_CHARS
            or not 1 <= len(intent) <= BROWSER_INTENT_CHARS
            or not 0 <= offset <= BROWSER_HISTORY_OFFSET_MAX
            or not 1 <= limit <= BROWSER_HISTORY_LIMIT_MAX
            or not isinstance(query_digest, str)
            or len(query_digest) != 64
            or not isinstance(history_revision, int)
            or isinstance(history_revision, bool)
            or history_revision < 0
            or frozenset(scope) != BROWSER_APPROVAL_SCOPE_FIELDS
            or scope["session_id"] != self._session_id
            or scope["turn_id"] != turn_id
        ):
            raise ValueError("browser history approval identity invalid")
        if expires_at <= time.time():
            return {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED}
        payload = {
            "request_id": request_id,
            "proof_id": proof_id,
            "kind": BROWSER_HISTORY_APPROVAL_KIND,
            "method": BROWSER_HISTORY_APPROVAL_METHOD,
            "search": search,
            "offset": offset,
            "limit": limit,
            "intent": intent,
            "query_digest": query_digest,
            "history_revision": history_revision,
            "expires_at": expires_at,
            **{
                field: scope[field]
                for field in BROWSER_APPROVAL_SCOPE_FIELDS - {"session_id", "turn_id"}
            },
        }
        loop = asyncio.get_running_loop()
        async with self._lock:
            if request_id in self._browser_waiters:
                raise RuntimeError("browser history approval is already waiting")
            with self._events.transaction() as connection:
                self._catalog.record_browser_hil(
                    connection=connection,
                    request_id=request_id,
                    session_id=self._session_id,
                    turn_id=turn_id,
                    payload=payload,
                    method=BROWSER_HISTORY_APPROVAL_METHOD,
                )
                requested = self._events.append(
                    session_id=self._session_id,
                    runtime_id=runtime_id,
                    vendor_thread_id=vendor_thread_id,
                    vendor_turn_id=turn_id,
                    vendor_item_id=None,
                    kind=PRODUCT_EVENT_HIL_REQUESTED,
                    payload=payload,
                    idempotency_key=f"browser:approval:{request_id}:requested",
                    connection=connection,
                )
            waiter: asyncio.Future[dict[str, Any]] = loop.create_future()
            self._browser_waiters[request_id] = waiter
            published = self._broadcast_browser(requested)
        try:
            if not published:
                denial = {"decision": "deny", "reason": BROWSER_APPROVAL_BROADCAST_FAILED}
                await self._resolve_browser(request_id, denial, turn_id=turn_id)
                return denial
            async with asyncio.timeout_at(loop.time() + max(0, expires_at - time.time())):
                return await asyncio.shield(waiter)
        except TimeoutError:
            await self._resolve_browser(
                request_id,
                {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED},
                turn_id=turn_id,
            )
            return {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED}
        except asyncio.CancelledError:
            await self._resolve_browser(
                request_id,
                {"decision": "deny", "reason": PRODUCT_INTERACTION_CANCELLED},
                turn_id=turn_id,
            )
            raise
        finally:
            self._browser_waiters.pop(request_id, None)

    async def _resolve_browser(
        self, request_id: str, decision: dict[str, Any], *, turn_id: str
    ) -> dict[str, Any] | None:
        if self._events is None or self._broadcast is None:
            return None
        async with self._lock:
            waiter = self._browser_waiters.get(request_id)
            if waiter is None or waiter.done():
                return None
            record = self._catalog.hil(request_id)
            if (
                record.method
                not in {
                    BROWSER_APPROVAL_METHOD,
                    BROWSER_HISTORY_APPROVAL_METHOD,
                }
                or record.vendor_turn_id != turn_id
            ):
                return None
            expiry = record.payload.get("expires_at")
            if decision.get("decision") == "allow_once" and (
                not isinstance(expiry, (int, float)) or expiry <= time.time()
            ):
                decision = {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED}
            session = self._catalog.get(self._session_id)
            if session is None:
                return None
            with self._events.transaction() as connection:
                if decision.get("decision") == "allow_once" and (
                    not isinstance(expiry, (int, float)) or expiry <= time.time()
                ):
                    decision = {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED}
                resolved = self._catalog.transition_browser_hil(
                    connection=connection,
                    request_id=request_id,
                    session_id=self._session_id,
                    turn_id=turn_id,
                    method=record.method,
                    decision=decision,
                )
                if resolved is None:
                    return None
                snapshot = interaction_snapshot(resolved)
                event = self._events.append(
                    session_id=self._session_id,
                    runtime_id=session.runtime_id,
                    vendor_thread_id=session.vendor_thread_id or "",
                    vendor_turn_id=turn_id,
                    vendor_item_id=None,
                    kind=PRODUCT_EVENT_HIL_RESOLVED,
                    payload=snapshot,
                    idempotency_key=f"browser:approval:{request_id}:resolved",
                    connection=connection,
                )
            waiter.set_result(decision)
            self._broadcast_browser(event)
            return snapshot

    def prepare_product_input(
        self,
        question: Mapping[str, Any],
        *,
        turn_id: str,
        item_id: str = "",
        timeout_seconds: float | None = None,
        blocking: bool = True,
    ) -> SessionHilRecord:
        request_id = str(question.get("id") or "").strip()
        if not request_id or not turn_id.strip():
            raise ValueError("product interaction identity is unavailable")
        if timeout_seconds is not None and (
            not math.isfinite(timeout_seconds) or timeout_seconds <= 0
        ):
            raise ValueError("product interaction timeout must be positive and finite")
        payload: dict[str, Any] = {
            "request_id": request_id,
            "session_id": self._session_id,
            "kind": "question",
            "method": USER_INPUT_METHOD,
            "lifetime": PRODUCT_INTERACTION_LIFETIME,
            PRODUCT_INTERACTION_BLOCKING: blocking,
            "questions": [dict(question)],
        }
        if timeout_seconds is not None:
            payload[PRODUCT_INTERACTION_TIMEOUT] = timeout_seconds
        if self._bind_component is not None:
            self._bind_component(question)
        return self._catalog.record_hil(
            product_request_id=request_id,
            session_id=self._session_id,
            vendor_request_id=request_id,
            vendor_turn_id=turn_id,
            vendor_item_id=item_id or None,
            method=PRODUCT_USER_INPUT_METHOD,
            payload=payload,
        )

    async def publish_product_input(
        self, question: Mapping[str, Any], *, turn_id: str
    ) -> dict[str, Any]:
        async with self._lock:
            record = self.prepare_product_input(question, turn_id=turn_id, blocking=False)
            await self._publish(
                PRODUCT_EVENT_HIL_REQUESTED,
                record.payload,
                turn_id=turn_id,
                idempotency_key=f"product:callback:{record.product_request_id}",
            )
            return interaction_snapshot(record)

    async def request_product_input(
        self,
        question: Mapping[str, Any],
        *,
        turn_id: str,
        item_id: str = "",
        timeout_seconds: float | None = None,
        activity: ActivityLease | None = None,
    ) -> dict[str, Any]:
        """Publish and wait for a product-owned question without routing through Runtime."""
        loop = asyncio.get_running_loop()
        async with self._lock:
            record = self.prepare_product_input(
                question,
                turn_id=turn_id,
                item_id=item_id,
                timeout_seconds=timeout_seconds,
            )
            request_id = record.product_request_id
            payload = record.payload
            if record.status is HilStatus.RESOLVED:
                return dict(record.decision or {})
            if record.status not in {HilStatus.PENDING, HilStatus.UNKNOWN}:
                return {"cancelled": True, "reason": PRODUCT_INTERACTION_CANCELLED}
            existing = self._product_waiters.get(request_id)
            waiter = existing if existing is not None else loop.create_future()
            self._product_waiters[request_id] = waiter
            if existing is None and activity is not None:
                self._product_activities[request_id] = activity
            session = self._catalog.get(self._session_id)
            if session is not None and (
                not session.last_turn_id
                or (
                    session.last_turn_id == turn_id
                    and session.last_turn_status not in TERMINAL_TURN_OUTCOMES
                )
            ):
                self._catalog.update_status(
                    self._session_id,
                    SessionStatus.WAITING_HIL,
                    turn_id=turn_id,
                    turn_status=PRODUCT_SESSION_STATE_WAITING,
                )
            if existing is None:
                try:
                    await self._publish(
                        PRODUCT_EVENT_HIL_REQUESTED,
                        payload,
                        turn_id=turn_id,
                        item_id=item_id,
                        idempotency_key=f"product:callback:{request_id}",
                    )
                except BaseException:
                    self._product_waiters.pop(request_id, None)
                    self._product_activities.pop(request_id, None)
                    self._catalog.resolve_hil(request_id, {"cancelled": True})
                    self._finish_components(record)
                    raise
        try:
            if timeout_seconds is None:
                return await asyncio.shield(waiter)
            remaining = max(0, record.created_at + timeout_seconds - time.time())
            try:
                return await asyncio.wait_for(asyncio.shield(waiter), remaining)
            except TimeoutError:
                async with self._lock:
                    await self._finish_product_input(
                        record, {PRODUCT_INTERACTION_TIMED_OUT: True}, turn_id
                    )
                return await asyncio.shield(waiter)
        except asyncio.CancelledError:
            if existing is None:
                async with self._lock:
                    await self._finish_product_input(
                        record,
                        {"cancelled": True, "reason": PRODUCT_INTERACTION_CANCELLED},
                        turn_id,
                    )
            raise
        finally:
            if waiter.done():
                self._product_waiters.pop(request_id, None)
                self._product_activities.pop(request_id, None)

    def product_activity(self, request_id: str) -> ActivityLease | None:
        """Return only the server-held owner of a currently waiting product question."""
        return self._product_activities.get(request_id)

    async def _finish_product_input(
        self, record: SessionHilRecord, decision: dict[str, Any], active_turn_id: str
    ) -> dict[str, Any] | None:
        request_id = record.product_request_id
        waiter = self._product_waiters.get(request_id)
        blocking = record.payload.get(PRODUCT_INTERACTION_BLOCKING, True)
        if blocking and (waiter is None or waiter.done()):
            return None
        if not self._catalog.resolve_hil(request_id, decision):
            stored = self._catalog.hil(request_id)
            if waiter is not None and stored.status not in {HilStatus.PENDING, HilStatus.UNKNOWN}:
                waiter.set_result(dict(stored.decision or {"cancelled": True}))
            return None
        session = self._catalog.get(self._session_id)
        if (
            blocking
            and active_turn_id == record.vendor_turn_id
            and session is not None
            and session.last_turn_id == active_turn_id
            and session.status in {SessionStatus.RUNNING, SessionStatus.WAITING_HIL}
        ):
            self._catalog.update_status(
                self._session_id,
                SessionStatus.RUNNING,
                turn_id=active_turn_id,
                turn_status=PRODUCT_SESSION_STATE_RUNNING,
            )
        resolved = interaction_snapshot(self._catalog.hil(request_id))
        try:
            await self._publish(
                PRODUCT_EVENT_HIL_RESOLVED,
                resolved,
                turn_id=record.vendor_turn_id or "",
                item_id=record.vendor_item_id or "",
                idempotency_key=f"product:callback:{request_id}:resolved",
            )
        finally:
            if waiter is not None and not waiter.done():
                waiter.set_result(decision)
            self._finish_components(record)
        return resolved

    def is_product_request(self, request_id: str) -> bool:
        try:
            return self._catalog.hil(request_id).method in {
                PRODUCT_USER_INPUT_METHOD,
                BROWSER_APPROVAL_METHOD,
                BROWSER_HISTORY_APPROVAL_METHOD,
            }
        except SessionAccessError:
            return False

    async def cancel_product_requests(self) -> None:
        """Resolve active product waiters as cancelled before their owning turn closes."""

        notifications: list[SessionHilRecord] = []
        async with self._lock:
            for request_id, waiter in tuple(self._product_waiters.items()):
                if waiter.done():
                    continue
                decision = {"cancelled": True, "reason": PRODUCT_INTERACTION_CANCELLED}
                changed = self._catalog.resolve_hil(request_id, decision)
                record = self._catalog.hil(request_id)
                if record.status in {HilStatus.PENDING, HilStatus.UNKNOWN}:
                    continue
                # Durable settlement owns the result, even after an earlier notification
                # failed. Settle the entire batch before any fallible asynchronous publish.
                waiter.set_result(dict(record.decision or {"cancelled": True}))
                self._finish_components(record)
                if changed:
                    notifications.append(record)
        failures: list[Exception] = []
        for record in notifications:
            try:
                await self._publish(
                    PRODUCT_EVENT_HIL_RESOLVED,
                    interaction_snapshot(record),
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                    idempotency_key=f"product:callback:{record.product_request_id}:cancelled",
                )
            except Exception as error:
                failures.append(error)
        for request_id in tuple(self._browser_waiters):
            try:
                record = self._catalog.hil(request_id)
                await self._resolve_browser(
                    request_id,
                    {"decision": "deny", "reason": PRODUCT_INTERACTION_CANCELLED},
                    turn_id=record.vendor_turn_id or "",
                )
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("product request cancellation failed", failures)

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
        self,
        runtime_session: RuntimeSession | None,
        request_id: str,
        response: Mapping[str, Any],
        *,
        active_turn_id: str = "",
    ) -> dict[str, Any] | None:
        try:
            existing = self._catalog.hil(request_id)
        except SessionAccessError:
            existing = None
        if existing is not None and existing.method in {
            BROWSER_APPROVAL_METHOD,
            BROWSER_HISTORY_APPROVAL_METHOD,
        }:
            if (
                set(response) != {"decision"}
                or response.get("decision") not in BROWSER_APPROVAL_DECISIONS
            ):
                return None
            if active_turn_id != existing.vendor_turn_id:
                await self._resolve_browser(
                    request_id,
                    {"decision": "deny", "reason": "turn_inactive"},
                    turn_id=existing.vendor_turn_id or "",
                )
                return None
            expiry = existing.payload.get("expires_at")
            if not isinstance(expiry, (int, float)) or expiry <= time.time():
                await self._resolve_browser(
                    request_id,
                    {"decision": "deny", "reason": BROWSER_APPROVAL_EXPIRED},
                    turn_id=existing.vendor_turn_id or "",
                )
                return None
            return await self._resolve_browser(
                request_id,
                {"decision": str(response["decision"])},
                turn_id=active_turn_id,
            )
        async with self._lock:
            pending = {
                row.product_request_id: row
                for row in self._catalog.pending_hil(self._session_id, blocking_only=False)
            }
            record = pending.get(request_id)
            if record is None:
                return None
            decision = dict(response)
            if record.method == PRODUCT_USER_INPUT_METHOD:
                decision.pop(PRODUCT_INTERACTION_TIMED_OUT, None)
                return await self._finish_product_input(record, decision, active_turn_id)
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
            self._finish_components(record)
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
