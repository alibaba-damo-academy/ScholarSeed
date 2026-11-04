"""Explicit hierarchical plans projected through the existing session event log."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import get_args

from service.chat.constants import PRODUCT_EVENT_PLAN_SNAPSHOT
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.platform.bridge import (
    PLAN_ACTION_STATUSES,
    PLAN_GROUP,
    PLAN_MAX_DEPTH,
    PLAN_RECONCILE_ACTION,
    PLAN_RELEASED_SOURCE,
    PLAN_SOURCE,
    PLAN_STEP,
    PLAN_TIMING_POLICY,
    PlanAction,
    PlanCommand,
    PlanStatus,
    PlanStructure,
)

PLAN_KEY_PREFIX = "plan"
PLAN_COMPLETED = "completed"
PLAN_PENDING = "pending"
PLAN_RUNNING = "in_progress"
PLAN_TIMED_TERMINALS = frozenset((PLAN_COMPLETED, "partial", "failed"))
PLAN_START_REQUIRED = "plan_step_start_required"
PLAN_STARTED_IDENTITY_LOCKED = "plan_started_step_identity_locked"
PLAN_STEP_UNKNOWN = "plan_step_unknown"
PLAN_RECONCILE_REASON_REQUIRED = "plan_reconcile_reason_required"
PLAN_RECONCILE_LEAF_REQUIRED = "plan_reconcile_unstarted_leaf_required"
PLAN_RECONCILABLE_STATUSES = frozenset((PLAN_PENDING, "blocked", "needs_confirmation"))


class PlanExecutionError(ValueError):
    def __init__(self, code: str, identities: list[str]) -> None:
        super().__init__(code)
        self.identities = identities


def execution_starts(
    items: list[dict], previous: dict, *, creating: bool, reconciled: frozenset[str] = frozenset()
) -> list[str]:
    old_items = {} if creating else {item["id"]: item for item in previous.get("items", [])}
    old_parents = group_ids(list(old_items.values()))
    parents = group_ids(items)
    started = set() if creating else set((previous.get("plan") or {}).get("started_ids", []))
    started.update(
        identity
        for identity, item in old_items.items()
        if identity not in old_parents and item["status"] == PLAN_RUNNING
    )
    identities = {item["id"] for item in items}
    removed = sorted(
        started - identities
        | started.intersection(parents)
        | (old_parents - parents).intersection(identities)
    )
    if removed:
        raise PlanExecutionError(PLAN_STARTED_IDENTITY_LOCKED, removed)
    missing = [
        item["id"]
        for item in items
        if item["id"] not in parents
        and item["status"] in PLAN_TIMED_TERMINALS
        and item["id"] not in reconciled
        and old_items.get(item["id"], {}).get("status") != PLAN_RUNNING
        and not (
            old_items.get(item["id"], {}).get("status") == item["status"]
            and (item["id"] in started or item["status"] == PLAN_COMPLETED)
        )
    ]
    if missing:
        raise PlanExecutionError(PLAN_START_REQUIRED, missing)
    started.update(
        item["id"] for item in items if item["id"] not in parents and item["status"] == PLAN_RUNNING
    )
    return sorted(started)


def group_ids(items: list[dict]) -> set[str]:
    return {item["parent_id"] for item in items if item.get("parent_id")} | {
        item["id"] for item in items if item.get("kind") == PLAN_GROUP
    }


def reconcilable_ids(state: dict) -> set[str]:
    items = state.get("items", [])
    started = set((state.get("plan") or {}).get("started_ids", []))
    parents = group_ids(items)
    return {
        item["id"]
        for item in items
        if item["id"] not in parents
        and item["id"] not in started
        and item["status"] in PLAN_RECONCILABLE_STATUSES
    }


class PlanConflict(ValueError):
    """The caller must reread the current plan before retrying a changed request."""


def progress_transitions(items: list[dict], previous: dict) -> dict[str, list[str]]:
    if (previous.get("plan") or {}).get("source") != PLAN_SOURCE:
        return {}
    result = {}
    for item in items:
        allowed = []
        for status in get_args(PlanStatus):
            candidate = [
                dict(row, status=status) if row["id"] == item["id"] else row for row in items
            ]
            try:
                validate_tree(candidate)
                execution_starts(candidate, previous, creating=False)
            except ValueError:
                continue
            allowed.append(status)
        result[item["id"]] = allowed
    return result


def validate_tree(items: list[dict]) -> None:
    by_id = {item["id"]: item for item in items}
    if len(by_id) != len(items):
        raise ValueError("plan_duplicate_id")
    for item in items:
        if not item["id"].strip() or not item["content"].strip():
            raise ValueError("plan_empty_text")
        children = [child for child in items if child.get("parent_id") == item["id"]]
        if children and item.get("kind") == PLAN_STEP:
            raise ValueError("plan_step_has_children")
        if (
            item.get("kind") == PLAN_GROUP
            and not children
            and item["status"] in PLAN_TIMED_TERMINALS
        ):
            raise ValueError("plan_group_requires_children")
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
        command: PlanCommand,
        *,
        runtime_id: str,
        vendor_thread_id: str,
        require_turn: Callable[[], None],
    ) -> ProductEventRecord:
        if isinstance(command, PlanAction):
            operation = "update"
            items = []
        else:
            operation = command.operation
            items = [item.model_dump() for item in command.items]
            if not isinstance(command, PlanStructure):
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
            if operation == "create":
                if metadata.get("plan_id") == command.plan_id:
                    raise PlanConflict("plan_already_exists")
            elif metadata.get("plan_id") != command.plan_id:
                raise PlanConflict("plan_identity_conflict")
            if isinstance(command, PlanStructure):
                old_statuses = (
                    {}
                    if operation == "create"
                    else {item["id"]: item["status"] for item in data.get("items", [])}
                )
                items = [
                    dict(item, status=old_statuses.get(item["id"], PLAN_PENDING)) for item in items
                ]
                validate_tree(items)
            if isinstance(command, PlanAction):
                changes = {
                    identity: PLAN_ACTION_STATUSES[command.action] for identity in command.step_ids
                }
                if len(changes) != len(command.step_ids):
                    raise ValueError("plan_duplicate_id")
                old_items = data.get("items", [])
                unknown = sorted(changes.keys() - {item["id"] for item in old_items})
                if unknown:
                    raise PlanExecutionError(PLAN_STEP_UNKNOWN, unknown)
                if command.action == PLAN_RECONCILE_ACTION:
                    if not command.reason.strip():
                        raise ValueError(PLAN_RECONCILE_REASON_REQUIRED)
                    invalid = sorted(changes.keys() - reconcilable_ids(data))
                    if invalid:
                        raise PlanExecutionError(PLAN_RECONCILE_LEAF_REQUIRED, invalid)
                items = [
                    dict(item, status=changes[item["id"]]) if item["id"] in changes else item
                    for item in old_items
                ]
                validate_tree(items)
            if operation != "create":
                if operation in {"revise", "release"} and not command.reason.strip():
                    raise ValueError("plan_revision_reason_required")
                if operation == "release" and items != data.get("items", []):
                    raise PlanConflict("plan_release_must_preserve_items")
                if operation == "update":
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
            reconciled = (
                frozenset(command.step_ids)
                if isinstance(command, PlanAction) and command.action == PLAN_RECONCILE_ACTION
                else frozenset()
            )
            started = execution_starts(
                items, data, creating=operation == "create", reconciled=reconciled
            )
            payload = {
                "items": items,
                "explanation": command.reason or None,
                "plan": {
                    "source": (PLAN_RELEASED_SOURCE if operation == "release" else PLAN_SOURCE),
                    "plan_id": command.plan_id,
                    "revision": revision + 1,
                    "started_ids": started,
                    **(
                        {"timing_policy": PLAN_TIMING_POLICY}
                        if operation == "create"
                        or metadata.get("timing_policy") == PLAN_TIMING_POLICY
                        else {}
                    ),
                },
                "operation": operation,
                "request_digest": digest,
            }
            owner_turn = (
                previous.vendor_turn_id or command.turn_id
                if operation == "release" and previous
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
