"""Build host plan mutations from a fresh read response without changing state."""

import copy
import json
import uuid

STAGES = {
    "materials": ("材料与授权", "Materials and authorization"),
    "evidence": ("证据与大纲", "Evidence and outline"),
    "writing": ("写作与素材", "Writing and assets"),
    "publication": ("出版与交付", "Publication and delivery"),
}
ITEM_FIELDS = ("id", "content", "status", "parent_id", "kind")
MAX_ENVELOPE_DEPTH = 4
RUNNING = "in_progress"
COMPLETED = "completed"
PENDING = "pending"
TIMED_TERMINALS = frozenset((COMPLETED, "partial", "failed"))
STATES = (RUNNING, COMPLETED, "partial", "blocked", "failed", "needs_confirmation")
FLAT = 'flat'
LEGACY = 'legacy'
PROTOCOLS = (FLAT, LEGACY)
ACTIONS = {RUNNING: 'start', COMPLETED: 'finish', 'partial': 'partial',
           'blocked': 'block', 'failed': 'fail', 'needs_confirmation': 'pause'}


def decode(snapshot):
    for _depth in range(MAX_ENVELOPE_DEPTH):
        if isinstance(snapshot, str):
            snapshot = json.loads(snapshot)
        elif isinstance(snapshot, list) and len(snapshot) == 1 and isinstance(snapshot[0], dict):
            snapshot = snapshot[0].get("text")
        elif isinstance(snapshot, dict) and "content" in snapshot and "ok" not in snapshot:
            snapshot = snapshot["content"]
        else:
            break
    if not isinstance(snapshot, dict) or snapshot.get("ok") is not True:
        raise ValueError("save the successful plan/get response unchanged")
    if not isinstance(snapshot.get("turn_id"), str) or not snapshot["turn_id"]:
        raise ValueError("plan/get must provide the current turn_id")
    if not isinstance(snapshot.get("items"), list):
        raise ValueError("plan/get must provide complete items")
    return snapshot


def transition(snapshot, item_id, state, language="CHINESE", complete=None, protocol=FLAT, reason=None):
    if protocol not in PROTOCOLS:
        raise ValueError('select the actually declared tool protocol: flat or legacy')
    if protocol == LEGACY:
        result = legacy_transition(snapshot, item_id, state, language, complete)
        if reason:
            result['request']['reason'] = reason
        return result
    snapshot = decode(snapshot)
    if state not in STATES:
        raise ValueError('unsupported progress state')
    plan = snapshot.get('plan')
    if plan is None:
        if snapshot['items'] or item_id not in STAGES or state != RUNNING or complete is not None:
            raise ValueError('create the declared stages before starting work')
        return {'operation': 'create', 'plan_id': uuid.uuid4().hex, 'expected_revision': 0,
                'request_id': uuid.uuid4().hex, 'turn_id': snapshot['turn_id'],
                'items': [{'id': identity, 'content': labels[0 if language == 'CHINESE' else 1],
                           'parent_id': None, 'kind': 'step'} for identity, labels in STAGES.items()]}
    if not isinstance(plan, dict) or not plan.get('plan_id') or type(plan.get('revision')) is not int:
        raise ValueError('plan/get must provide plan_id and revision')
    by_id = {item['id']: item for item in snapshot['items']}
    if len(by_id) != len(snapshot['items']) or item_id not in by_id:
        raise ValueError('select an actual unique item_id from plan/get')
    target_id = item_id
    action = ACTIONS[state]
    if complete is not None:
        if state != RUNNING or complete == item_id or complete not in by_id:
            raise ValueError('complete names a different existing stage before starting the next')
        target_id, action = complete, ACTIONS[COMPLETED]
    target = by_id[target_id]
    requested_state = COMPLETED if complete is not None else state
    if target.get('status') == requested_state:
        raise ValueError('stage already has the requested state; no mutation needed; retain an uncertain original payload')
    children = [item for item in by_id.values() if item.get('parent_id') == target_id]
    if target.get('kind') == 'group' or children:
        if action != ACTIONS[COMPLETED] or not children or any(child['status'] != COMPLETED for child in children):
            raise ValueError('finish a group only after its existing children complete; execute actual leaves')
    if action not in snapshot.get('actions', {}).get(target_id, []):
        raise ValueError('action is not allowed by current plan/get; reread state without fabricating starts')
    result = {'operation': action, 'plan_id': plan['plan_id'], 'expected_revision': plan['revision'],
              'request_id': uuid.uuid4().hex, 'turn_id': snapshot['turn_id'], 'step_ids': [target_id]}
    if reason:
        result['reason'] = reason
    return result


def legacy_transition(snapshot, item_id, state, language="CHINESE", complete=None):
    snapshot = decode(snapshot)
    if state not in STATES:
        raise ValueError("unsupported progress state")
    plan = snapshot.get("plan")
    creating = plan is None
    if creating:
        if snapshot["items"] or item_id not in STAGES or state != RUNNING:
            raise ValueError("a new tracker starts one declared stage in_progress")
        items = [
            {
                "id": identity,
                "content": labels[0 if language == "CHINESE" else 1],
                "status": PENDING,
                "parent_id": None,
                "kind": "step",
            }
            for identity, labels in STAGES.items()
        ]
        plan = {"plan_id": uuid.uuid4().hex, "revision": 0, "started_ids": []}
    else:
        if (
            not isinstance(plan, dict)
            or not plan.get("plan_id")
            or type(plan.get("revision")) is not int
        ):
            raise ValueError("plan/get must provide plan_id and revision")
        items = [
            {key: copy.deepcopy(value) for key, value in item.items() if key in ITEM_FIELDS}
            for item in snapshot["items"]
        ]
    by_id = {item["id"]: item for item in items}
    if len(by_id) != len(items) or item_id not in by_id:
        raise ValueError(
            "select an actual unique item_id from plan/get; scope changes use the host revise contract"
        )
    if any(item.get("parent_id") and item["parent_id"] not in by_id for item in items):
        raise ValueError("plan/get tree has a missing parent")
    target = by_id[item_id]
    if complete is not None:
        if creating or complete == item_id or complete not in by_id or state != RUNNING:
            raise ValueError("complete names a different existing stage before starting the next")
        previous = by_id[complete]
        if previous.get("kind") == "group" or any(
            item.get("parent_id") == complete for item in items
        ):
            raise ValueError("complete an existing group through its own observed transition")
        if previous["status"] != RUNNING and not (
            previous["status"] == COMPLETED and complete in plan.get("started_ids", [])
        ):
            raise ValueError("start the previous work before completing its step")
        previous["status"] = COMPLETED
    children = [item for item in items if item.get("parent_id") == item_id]
    if children or target.get("kind") == "group":
        if state == COMPLETED and (
            not children or any(child["status"] != COMPLETED for child in children)
        ):
            raise ValueError("complete the existing children before their group")
    elif state in TIMED_TERMINALS and target["status"] != RUNNING:
        if not (item_id in plan.get("started_ids", []) and target["status"] == state):
            raise ValueError(
                "start the actual work before completing its step; no retroactive starts"
            )
    target["status"] = state
    return {
        "operation": "write",
        "request": {
            "operation": "create" if creating else "update",
            "plan_id": plan["plan_id"],
            "expected_revision": plan["revision"],
            "request_id": uuid.uuid4().hex,
            "turn_id": snapshot["turn_id"],
            "items": items,
        },
    }
