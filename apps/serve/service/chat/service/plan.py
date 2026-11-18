"""Explicit hierarchical plans projected through the existing session event log."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import replace
from typing import get_args

from service.chat.constants import (
    PRODUCT_EVENT_PLAN_ENABLEMENT,
    PRODUCT_EVENT_PLAN_SNAPSHOT,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
)
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.platform.bridge import (
    PLAN_ACTION_STATUSES,
    PLAN_COMPLETE_ACTION,
    PLAN_COMPLETION_REASON_REQUIRED,
    PLAN_GROUP,
    PLAN_ID_CHARS,
    PLAN_INITIAL_REVISION,
    PLAN_MAX_DEPTH,
    PLAN_MAX_ITEMS,
    PLAN_RECONCILE_ACTION,
    PLAN_RELEASED_SOURCE,
    PLAN_SOURCE,
    PLAN_STEP,
    PLAN_TIMING_POLICY,
    SERVICE_PLAN_TOOL_NAME,
    PlanAction,
    PlanCommand,
    PlanEnable,
    PlanNode,
    PlanStatus,
    PlanStructure,
    PlanWrite,
)
from service.platform.vocabulary import BRIDGE_MAX_RESPONSE_BYTES

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
PLAN_COMPLETION_TARGET_REQUIRED = "plan_completion_target_invalid"
PLAN_COMPLETION_ACTIONS = frozenset(("finish", PLAN_RECONCILE_ACTION, PLAN_COMPLETE_ACTION))
PLAN_START_ACTION = "start"
PLAN_READ_ACTION = "get"
PLAN_PARAMETER_REJECTION = "bridge_invalid_parameters"
PLAN_STRUCTURE_ACTIONS = frozenset(get_args(PlanStructure.model_fields["operation"].annotation))
PLAN_RECOVERY_ACTIONS = PLAN_STRUCTURE_ACTIONS | PLAN_ACTION_STATUSES.keys() | {PLAN_READ_ACTION}
PLAN_UNFINISHED_CHILD = "plan_completed_parent_has_unfinished_child"
PLAN_EMPTY_GROUP = "plan_group_requires_children"
PLAN_REVISION_CONFLICT = "plan_revision_conflict"
PLAN_ROOTS_LOCKED = "plan_roots_locked_use_revise"
PLAN_PARENT_LOCKED = "plan_parent_locked_use_revise"
PLAN_REVISION_REASON_REQUIRED = "plan_revision_reason_required"
PLAN_RELEASE_PRESERVES_ITEMS = "plan_release_must_preserve_items"
PLAN_RECOVERY_REJECTIONS = frozenset(
    (
        PLAN_START_REQUIRED,
        PLAN_RECONCILE_LEAF_REQUIRED,
        PLAN_COMPLETION_TARGET_REQUIRED,
        PLAN_UNFINISHED_CHILD,
        PLAN_EMPTY_GROUP,
        PLAN_REVISION_CONFLICT,
        PLAN_PARAMETER_REJECTION,
        PLAN_ROOTS_LOCKED,
        PLAN_PARENT_LOCKED,
        PLAN_REVISION_REASON_REQUIRED,
        PLAN_RELEASE_PRESERVES_ITEMS,
    )
)
PLAN_FAILURE_FIELD = "plan_failure"
RESOLVED_TOOLS_FIELD = "resolved_tool_ids"
PLAN_TOOL_TEXT_TYPE = "inputText"
PLAN_TERMINAL_EVENTS = frozenset(
    (
        PRODUCT_EVENT_TURN_COMPLETED,
        PRODUCT_EVENT_TURN_FAILED,
        PRODUCT_EVENT_TURN_INTERRUPTED,
        PRODUCT_EVENT_TURN_UNKNOWN,
    )
)


def plan_nodes(nodes: object, *, snapshot: bool = False) -> list[dict] | None:
    if not isinstance(nodes, list) or not nodes or len(nodes) > PLAN_MAX_ITEMS:
        return None
    try:
        normalized = [
            PlanNode.model_validate(
                {key: value for key, value in node.items() if key in PlanNode.model_fields}
                if snapshot and isinstance(node, Mapping)
                else node
            ).model_dump()
            for node in nodes
        ]
        validate_tree([dict(node, status=PLAN_PENDING) for node in normalized])
    except ValueError:
        return None
    parents = group_ids(normalized)
    return [
        dict(node, kind=PLAN_GROUP if node["id"] in parents else PLAN_STEP) for node in normalized
    ]


def completion_ids(state: dict) -> set[str]:
    items = state.get("items", [])
    parents = group_ids(items)
    children = {
        parent: [item for item in items if item.get("parent_id") == parent] for parent in parents
    }
    return (
        reconcilable_ids(state)
        | {
            item["id"]
            for item in items
            if item["id"] not in parents and item["status"] in {PLAN_RUNNING, PLAN_COMPLETED}
        }
        | {
            parent
            for parent, descendants in children.items()
            if descendants and all(item["status"] == PLAN_COMPLETED for item in descendants)
        }
    )


def plan_tool_receipt(
    arguments: object, result: dict, turn_id: str, *, current: dict | None = None
) -> dict:
    if not isinstance(arguments, Mapping):
        return {}
    operation = arguments.get("operation")
    if not isinstance(operation, str) or operation not in PLAN_RECOVERY_ACTIONS:
        return {}
    if operation == PLAN_READ_ACTION:
        if result.get("ok") is False and result.get("error") == PLAN_PARAMETER_REJECTION:
            return {PLAN_FAILURE_FIELD: {"operation": operation, "error": PLAN_PARAMETER_REJECTION}}
        if (
            result.get("ok") is True
            and result.get("turn_id") == turn_id
            and isinstance(result.get("items"), list)
            and "plan" in result
            and (result["plan"] is None or isinstance(result["plan"], Mapping))
        ):
            return {"operation": operation}
        return {}
    state = result if result.get("ok") is True else result.get("current") or current
    if not isinstance(state, dict) or state.get("turn_id") != turn_id:
        return {}
    metadata = state.get("plan") or {}
    if not isinstance(metadata, Mapping):
        return {}
    revision = metadata.get("revision", PLAN_INITIAL_REVISION)
    plan_id = arguments.get("plan_id")
    if (
        not isinstance(plan_id, str)
        or not plan_id.strip()
        or len(plan_id) > PLAN_ID_CHARS
        or not isinstance(revision, int)
        or isinstance(revision, bool)
        or revision < PLAN_INITIAL_REVISION
        or (
            metadata.get("plan_id") != plan_id
            and not (operation == "create" and result.get("ok") is False)
        )
    ):
        return {}
    items = state.get("items")
    if not isinstance(items, list) or any(
        not isinstance(item, Mapping) or not isinstance(item.get("id"), str) for item in items
    ):
        return {}
    error = result.get("error")
    rejected = (
        result.get("ok") is False and isinstance(error, str) and error in PLAN_RECOVERY_REJECTIONS
    )
    if operation in PLAN_STRUCTURE_ACTIONS:
        nodes = plan_nodes(arguments.get("items"))
        if nodes is None:
            return {}
        if rejected:
            return {
                PLAN_FAILURE_FIELD: {
                    "plan_id": plan_id,
                    "revision": revision,
                    "operation": operation,
                    "nodes": nodes,
                    "source": PLAN_RELEASED_SOURCE if operation == "release" else PLAN_SOURCE,
                    "error": error,
                }
            }
    requested = arguments.get("step_ids")
    if operation not in PLAN_STRUCTURE_ACTIONS:
        if (
            not isinstance(requested, list)
            or not requested
            or len(requested) > PLAN_MAX_ITEMS
            or not all(isinstance(identity, str) and identity for identity in requested)
        ):
            return {}
        if not set(requested) <= {item["id"] for item in items}:
            return {}
    if rejected:
        return {
            PLAN_FAILURE_FIELD: {
                "plan_id": plan_id,
                "revision": revision,
                "step_ids": requested,
                "error": error,
                "operation": operation,
            }
        }
    if result.get("ok") is True:
        return {
            "operation": operation,
            "plan_id": plan_id,
            "revision": revision,
            "nodes": plan_nodes(items, snapshot=True),
            "source": metadata.get("source"),
            "statuses": {item["id"]: item.get("status") for item in items},
            "completed_ids": [item["id"] for item in items if item.get("status") == PLAN_COMPLETED],
            "started_ids": metadata.get("started_ids", []),
        }
    return {}


def plan_tool_recoveries(
    receipt: dict, records: Iterable[ProductEventRecord], turn_id: str
) -> list[str]:
    reading = receipt.get("operation") == PLAN_READ_ACTION
    if not reading and not receipt.get("plan_id"):
        return []
    completed = set(receipt.get("completed_ids", []))
    started = set(receipt.get("started_ids", []))
    recovered = []
    for record in records:
        if (
            record.kind != PRODUCT_EVENT_TOOL_COMPLETED
            or record.vendor_turn_id != turn_id
            or record.payload.get("success") is not False
        ):
            continue
        failure = record.payload.get(PLAN_FAILURE_FIELD)
        if not isinstance(failure, dict):
            continue
        if reading:
            if (
                failure.get("operation") == PLAN_READ_ACTION
                and failure.get("error") == PLAN_PARAMETER_REJECTION
                and record.payload.get("tool_id")
            ):
                recovered.append(record.payload["tool_id"])
            continue
        failure_revision = failure.get("revision")
        receipt_revision = receipt.get("revision")
        if not (
            failure.get("plan_id") == receipt.get("plan_id")
            and isinstance(failure_revision, int)
            and not isinstance(failure_revision, bool)
            and isinstance(receipt_revision, int)
            and not isinstance(receipt_revision, bool)
            and failure_revision < receipt_revision
            and record.payload.get("tool_id")
        ):
            continue
        operation = failure.get("operation")
        if operation in PLAN_STRUCTURE_ACTIONS:
            if (
                failure.get("nodes") == receipt.get("nodes")
                and failure.get("source") == receipt.get("source")
                and (
                    operation not in {"create", "release"} or receipt.get("operation") == operation
                )
            ):
                recovered.append(record.payload["tool_id"])
            continue
        targets = failure.get("step_ids")
        if not isinstance(targets, list) or not targets or operation not in PLAN_ACTION_STATUSES:
            continue
        matching = (
            started
            if operation == PLAN_START_ACTION
            else (
                completed
                if operation in PLAN_COMPLETION_ACTIONS
                else {
                    identity
                    for identity, status in receipt.get("statuses", {}).items()
                    if status == PLAN_ACTION_STATUSES[operation]
                }
            )
        )
        if set(targets) <= matching:
            recovered.append(record.payload["tool_id"])
    return list(dict.fromkeys(recovered))


def plan_tool_result(output: object) -> dict | None:
    if not isinstance(output, str) or len(output) > BRIDGE_MAX_RESPONSE_BYTES:
        return None
    try:
        if len(output.encode()) > BRIDGE_MAX_RESPONSE_BYTES:
            return None
        result = json.loads(output)
        if isinstance(result, list) and len(result) == 1:
            block = result[0]
            if not isinstance(block, dict) or block.get("type") != PLAN_TOOL_TEXT_TYPE:
                return None
            result = json.loads(block["text"])
    except (ValueError, KeyError, TypeError, RecursionError, UnicodeError):
        return None
    return result if isinstance(result, dict) else None


class PlanToolProjection:
    def __init__(self) -> None:
        self._inputs: dict[tuple, object] = {}
        self._failures: dict[tuple, ProductEventRecord] = {}
        self._states: dict[tuple, dict] = {}

    def project(self, record: ProductEventRecord) -> ProductEventRecord:
        scope = (record.session_id, record.runtime_id, record.vendor_thread_id)
        turn = (*scope, record.vendor_turn_id)
        if record.kind == PRODUCT_EVENT_PLAN_SNAPSHOT:
            self._states[scope] = record.payload
        if record.kind in PLAN_TERMINAL_EVENTS:
            self._inputs = {key: value for key, value in self._inputs.items() if key[:4] != turn}
            self._failures = {
                key: value for key, value in self._failures.items() if key[:4] != turn
            }
        payload = record.payload
        identity = payload.get("tool_id")
        if (
            not all(scope)
            or not record.vendor_turn_id
            or not identity
            or identity != record.vendor_item_id
            or payload.get("name") != SERVICE_PLAN_TOOL_NAME
        ):
            return record
        key = (*turn, identity)
        if record.kind == PRODUCT_EVENT_TOOL_STARTED:
            self._inputs[key] = payload.get("input")
            return record
        if record.kind != PRODUCT_EVENT_TOOL_COMPLETED:
            return record
        arguments = self._inputs.pop(key, None)
        result = plan_tool_result(payload.get("output"))
        receipt = {}
        if (
            result is not None
            and isinstance(result.get("ok"), bool)
            and result["ok"] is payload.get("success")
        ):
            current = self._states.get(scope)
            receipt = plan_tool_receipt(
                arguments,
                result,
                record.vendor_turn_id,
                current=(
                    {**current, "turn_id": record.vendor_turn_id} if current is not None else None
                ),
            )
            if result["ok"] and result.get("turn_id") == record.vendor_turn_id:
                self._states[scope] = result
        projected = dict(payload)
        if payload.get("success") is False:
            if PLAN_FAILURE_FIELD not in projected and PLAN_FAILURE_FIELD in receipt:
                projected.update(receipt)
            if PLAN_FAILURE_FIELD in projected:
                self._failures[key] = replace(record, payload=projected)
        elif payload.get("success") is True:
            failures = [value for identity, value in self._failures.items() if identity[:4] == turn]
            resolved = list(
                dict.fromkeys(
                    [
                        *projected.get(RESOLVED_TOOLS_FIELD, []),
                        *plan_tool_recoveries(receipt, failures, record.vendor_turn_id),
                    ]
                )
            )
            if resolved:
                projected[RESOLVED_TOOLS_FIELD] = resolved
                for identity in resolved:
                    self._failures.pop((*turn, identity), None)
        return replace(record, payload=projected) if projected != payload else record


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
            raise ValueError(PLAN_EMPTY_GROUP)
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
                raise ValueError(PLAN_UNFINISHED_CHILD)
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

    def enabled(self) -> bool:
        """Legacy structured trees retain their owner; native steps never opt in."""
        snapshot = self.events.latest_kind(self.session_id, PRODUCT_EVENT_PLAN_SNAPSHOT)
        selection = self.events.latest_kind(self.session_id, PRODUCT_EVENT_PLAN_ENABLEMENT)
        if selection and (snapshot is None or selection.product_seq > snapshot.product_seq):
            return selection.payload.get("enabled") is True
        if snapshot:
            source = (snapshot.payload.get("plan") or {}).get("source")
            if source == PLAN_SOURCE:
                return True
            if source == PLAN_RELEASED_SOURCE:
                return False
        return bool(selection and selection.payload.get("enabled") is True)

    def enable(
        self,
        command: PlanEnable,
        *,
        turn_id: str,
        runtime_id: str,
        vendor_thread_id: str,
        require_turn: Callable[[], None],
    ) -> ProductEventRecord | None:
        with self.events.transaction() as connection:
            require_turn()
            if self.enabled():
                return None
            selection = self.events.latest_kind(
                self.session_id, PRODUCT_EVENT_PLAN_ENABLEMENT, connection=connection
            )
            return self.events.append(
                session_id=self.session_id,
                runtime_id=runtime_id,
                vendor_thread_id=vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=None,
                kind=PRODUCT_EVENT_PLAN_ENABLEMENT,
                payload={"enabled": True, **command.model_dump()},
                idempotency_key=f"plan-enable:{turn_id}:{selection.product_seq if selection else 0}",
                connection=connection,
            )

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
        digest = hashlib.sha256(command.model_dump_json(exclude_unset=True).encode()).hexdigest()
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
            revision = metadata.get("revision", PLAN_INITIAL_REVISION)
            if command.expected_revision != revision:
                raise PlanConflict(PLAN_REVISION_CONFLICT)
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
                if command.action == PLAN_COMPLETE_ACTION:
                    if not command.reason.strip():
                        raise ValueError(PLAN_COMPLETION_REASON_REQUIRED)
                    containers = {item["parent_id"] for item in old_items if item.get("parent_id")}
                    invalid = sorted(changes.keys() - completion_ids(data) - containers)
                    if invalid:
                        raise PlanExecutionError(PLAN_COMPLETION_TARGET_REQUIRED, invalid)
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
                    raise ValueError(PLAN_REVISION_REASON_REQUIRED)
                if operation == "release" and items != data.get("items", []):
                    raise PlanConflict(PLAN_RELEASE_PRESERVES_ITEMS)
                if operation == "update":
                    old_items = data.get("items", [])
                    if roots(old_items) != roots(items):
                        raise PlanConflict(PLAN_ROOTS_LOCKED)
                    old_parents = {item["id"]: item.get("parent_id") for item in old_items}
                    if any(
                        item["id"] in old_parents
                        and old_parents[item["id"]] != item.get("parent_id")
                        for item in items
                    ):
                        raise PlanConflict(PLAN_PARENT_LOCKED)
            reconciled = (
                frozenset(command.step_ids)
                if isinstance(command, PlanAction)
                and command.action in {PLAN_RECONCILE_ACTION, PLAN_COMPLETE_ACTION}
                else frozenset()
            )
            if reconciled:
                reconciled = reconciled.intersection(reconcilable_ids(data))
            started = execution_starts(
                items, data, creating=operation == "create", reconciled=reconciled
            )
            estimate = (
                None if operation in {"create", "revise", "release"} else metadata.get("estimate")
            )
            if (
                isinstance(command, (PlanStructure, PlanWrite))
                and "estimate" in command.model_fields_set
            ):
                estimate = command.estimate.model_dump() if command.estimate else None
            payload = {
                "items": items,
                "explanation": command.reason or None,
                "plan": {
                    "source": (PLAN_RELEASED_SOURCE if operation == "release" else PLAN_SOURCE),
                    "plan_id": command.plan_id,
                    "revision": revision + 1,
                    "estimate": estimate,
                    "started_ids": started,
                    "reconciled_ids": sorted(
                        (
                            (
                                set()
                                if operation == "create"
                                else set(metadata.get("reconciled_ids", []))
                            )
                            | reconciled
                        )
                        & {item["id"] for item in items if item["status"] == PLAN_COMPLETED}
                        - set(started)
                    ),
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
            if operation == "release":
                self.events.append(
                    session_id=self.session_id,
                    runtime_id=runtime_id,
                    vendor_thread_id=vendor_thread_id,
                    vendor_turn_id=command.turn_id,
                    vendor_item_id=None,
                    kind=PRODUCT_EVENT_PLAN_ENABLEMENT,
                    payload={"enabled": False},
                    idempotency_key=f"{key}:enablement",
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
