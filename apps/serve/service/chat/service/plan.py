"""Explicit hierarchical plans projected through the existing session event log."""

from __future__ import annotations

import hashlib
from collections.abc import Callable

from service.chat.constants import PRODUCT_EVENT_PLAN_SNAPSHOT
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.platform.bridge import PLAN_MAX_DEPTH, PLAN_RELEASED_SOURCE, PLAN_SOURCE, PlanWrite

PLAN_KEY_PREFIX = "plan"
PLAN_COMPLETED = "completed"


class PlanConflict(ValueError):
    """The caller must reread the current plan before retrying a changed request."""


def validate_tree(items: list[dict]) -> None:
    by_id = {item["id"]: item for item in items}
    if len(by_id) != len(items):
        raise ValueError("plan_duplicate_id")
    for item in items:
        if not item["id"].strip() or not item["content"].strip():
            raise ValueError("plan_empty_text")
        seen = {item["id"]}
        parent = item.get("parent_id")
        while parent is not None:
            if parent not in by_id:
                raise ValueError("plan_parent_missing")
            if parent in seen:
                raise ValueError("plan_cycle")
            seen.add(parent)
            if len(seen) > PLAN_MAX_DEPTH:
                raise ValueError("plan_depth_exceeded")
            ancestor = by_id[parent]
            if ancestor["status"] == PLAN_COMPLETED and item["status"] != PLAN_COMPLETED:
                raise ValueError("plan_completed_parent_has_unfinished_child")
            parent = ancestor.get("parent_id")


def roots(items: list[dict]) -> list[tuple[str, str]]:
    return [(item["id"], item["content"]) for item in items if item.get("parent_id") is None]


class SessionPlans:
    def __init__(self, session_id: str, events: ProductEventStore, catalog: SessionCatalogStore):
        self.session_id = session_id
        self.events = events
        self.catalog = catalog

    def current(self) -> dict:
        event = self.events.latest_kind(self.session_id, PRODUCT_EVENT_PLAN_SNAPSHOT)
        return dict(event.payload) if event else {"items": [], "plan": None}

    def write(
        self,
        command: PlanWrite,
        *,
        runtime_id: str,
        vendor_thread_id: str,
        require_turn: Callable[[], None],
    ) -> ProductEventRecord:
        items = [item.model_dump() for item in command.items]
        validate_tree(items)
        digest = hashlib.sha256(command.model_dump_json().encode()).hexdigest()
        key = f"{PLAN_KEY_PREFIX}:{command.turn_id}:{command.request_id}"
        with self.events.transaction() as connection:
            require_turn()
            prior = self.events.by_key(self.session_id, key, connection=connection)
            if prior:
                if prior.payload.get("request_digest") != digest:
                    raise PlanConflict("plan_request_id_reused")
                return prior
            previous = self.events.latest_kind(
                self.session_id, PRODUCT_EVENT_PLAN_SNAPSHOT, connection=connection
            )
            data = previous.payload if previous else {}
            metadata = data.get("plan") or {}
            revision = metadata.get("revision", 0)
            if command.expected_revision != revision:
                raise PlanConflict("plan_revision_conflict")
            if command.operation == "create":
                if metadata.get("plan_id") == command.plan_id:
                    raise PlanConflict("plan_already_exists")
            else:
                if metadata.get("plan_id") != command.plan_id:
                    raise PlanConflict("plan_identity_conflict")
                if command.operation in {"revise", "release"} and not command.reason.strip():
                    raise ValueError("plan_revision_reason_required")
                if command.operation == "release" and items != data.get("items", []):
                    raise PlanConflict("plan_release_must_preserve_items")
                if command.operation == "update":
                    old_items = data.get("items", [])
                    if roots(old_items) != roots(items):
                        raise PlanConflict("plan_roots_locked_use_revise")
                    old_parents = {item["id"]: item.get("parent_id") for item in old_items}
                    if any(
                        item["id"] in old_parents
                        and old_parents[item["id"]] != item.get("parent_id")
                        for item in items
                    ):
                        raise PlanConflict("plan_parent_locked_use_revise")
            payload = {
                "items": items,
                "explanation": command.reason or None,
                "plan": {
                    "source": (
                        PLAN_RELEASED_SOURCE if command.operation == "release" else PLAN_SOURCE
                    ),
                    "plan_id": command.plan_id,
                    "revision": revision + 1,
                },
                "operation": command.operation,
                "request_digest": digest,
            }
            owner_turn = (
                previous.vendor_turn_id or command.turn_id
                if command.operation == "release" and previous
                else command.turn_id
            )
            event = self.events.append(
                session_id=self.session_id,
                runtime_id=runtime_id,
                vendor_thread_id=vendor_thread_id,
                vendor_turn_id=owner_turn,
                vendor_item_id=None,
                kind=PRODUCT_EVENT_PLAN_SNAPSHOT,
                payload=payload,
                idempotency_key=key,
                connection=connection,
            )
            self.catalog.save_todos(
                self.session_id,
                items,
                vendor_turn_id=owner_turn,
                product_seq=event.product_seq,
                explanation=command.reason or None,
                connection=connection,
            )
        return event

    def native(
        self,
        items: list[dict],
        *,
        runtime_id: str,
        vendor_thread_id: str,
        turn_id: str,
        item_id: str,
        key: str,
        explanation: str | None,
    ) -> ProductEventRecord | None:
        with self.events.transaction() as connection:
            previous = self.events.latest_kind(
                self.session_id, PRODUCT_EVENT_PLAN_SNAPSHOT, connection=connection
            )
            if previous and (previous.payload.get("plan") or {}).get("source") == PLAN_SOURCE:
                # The native runtime event remains trace evidence. It has no
                # parent identity and cannot replace an explicitly declared tree.
                return None
            event = self.events.append(
                session_id=self.session_id,
                runtime_id=runtime_id,
                vendor_thread_id=vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id or None,
                kind=PRODUCT_EVENT_PLAN_SNAPSHOT,
                payload={"items": items, "explanation": explanation},
                idempotency_key=key,
                connection=connection,
            )
            self.catalog.save_todos(
                self.session_id,
                items,
                vendor_turn_id=turn_id,
                product_seq=event.product_seq,
                explanation=explanation,
                connection=connection,
            )
        return event
