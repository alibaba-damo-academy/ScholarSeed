"""Shared review lock and timeout receipt invariants."""

import json
import math
import threading
from contextlib import contextmanager
from pathlib import Path

from platform_io import file_lock

SECONDS = 300
WAIT_MAX_SECONDS = 30
WAIT_POLL_SECONDS = 0.25
REVIEW_DIRECTORY = "04_outline"
REVIEW_LOCK = "review.lock"
REVIEW_WAIT = "review_wait.json"
AUTO_MODE = "auto"
REQUIRED_MODE = "required"
TIMEOUT_MODE = "timeout_auto"
AWAITING_DISPLAY = "awaiting_display"
WAITING = "waiting"
EXPIRED = "expired"
RESPONDED = "responded"
APPLYING_TIMEOUT = "applying_timeout"
TIMEOUT_APPLIED = "timeout_applied"
APPROVED = "approved"
STALE = "stale"
NOT_ENABLED = "not_enabled"
USER_DECISION = "user"
TIMEOUT_DECISION = "timeout_default"
LATE_RESPONSE = "late_response"
NO_MATCHING_WAIT = "no_matching_wait"

TIMEOUT_TRANSITIONS = frozenset({APPLYING_TIMEOUT, TIMEOUT_APPLIED})
_held = threading.local()


@contextmanager
def lock(ws):
    path = Path(ws).resolve() / REVIEW_DIRECTORY / REVIEW_LOCK
    held = getattr(_held, "paths", set())
    if path in held:
        yield
        return
    with file_lock(path):
        _held.paths = held | {path}
        try:
            yield
        finally:
            _held.paths = held


def _read(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _path(ws):
    return Path(ws) / REVIEW_DIRECTORY / REVIEW_WAIT


def _valid_window(state):
    start = state.get("started_at")
    end = state.get("deadline_at")
    return (
        type(start) in (int, float)
        and type(end) in (int, float)
        and math.isfinite(start)
        and math.isfinite(end)
        and end - start == SECONDS
    )


def packet_identity(workspace, previous, snapshot):
    if previous.get("snapshot") == snapshot:
        return previous.get("packet_id")
    state = _read(_path(workspace))
    if (
        state.get("state") in TIMEOUT_TRANSITIONS
        and state.get("packet_id") == previous.get("packet_id")
        and state.get("snapshot") == previous.get("snapshot")
        and state.get("approval_snapshot") == snapshot
        and _valid_window(state)
    ):
        return state.get("packet_id")
    return None


def valid_timeout_approval(ws, approval, snapshot):
    """A timeout receipt must agree with the persisted, actually expired window."""
    state = _read(_path(ws))
    return (
        snapshot["request"].get("outline_review") == TIMEOUT_MODE
        and approval.get("decision_source") == TIMEOUT_DECISION
        and approval.get("user_response") is None
        and _valid_window(state)
        and state.get("state") == TIMEOUT_APPLIED
        and bool(state.get("decision_id"))
        and bool(state.get("packet_id"))
        and state.get("decision_id") == approval.get("decision_id")
        and state.get("packet_id") == approval.get("source_packet_id")
        and state.get("approval_snapshot") == snapshot == approval.get("snapshot")
        and state.get("publication") == approval.get("publication") == snapshot["publication"]
        and type(state.get("decided_at")) in (int, float)
        and approval.get("decided_at") == state.get("decided_at")
        and state["decided_at"] >= state["deadline_at"]
    )
