"""Durable five-minute review policy. Hosts own delivery and wakeups."""

import math
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from citation_styles import style_labels
from confirmation import (
    APPLYING_TIMEOUT,
    APPROVED,
    AWAITING_DISPLAY,
    EXPIRED,
    LATE_RESPONSE,
    NO_MATCHING_WAIT,
    NOT_ENABLED,
    RESPONDED,
    SECONDS,
    STALE,
    TIMEOUT_APPLIED,
    TIMEOUT_DECISION,
    TIMEOUT_MODE,
    USER_DECISION,
    WAIT_MAX_SECONDS,
    WAIT_POLL_SECONDS,
    WAITING,
    _path,
    _read,
    _valid_window,
    lock,
    valid_timeout_approval,
)
from publication import validate_publication_choice
from task_contract import atomic_json, configure, read_request
from writing_contract import approval_snapshot, digest

HOST_RECEIPT_FIELDS = frozenset(("packet_id", "snapshot_id", "request_id", "started_at", "deadline_at", "decision"))
HOST_TIMEOUT_KEY = "timed_out"
HOST_CANCELLED_KEY = "cancelled"
HOST_RECEIPT_KEY = "host_receipt"


def complete(ws, value):
    if not isinstance(value, dict) or set(value) != HOST_RECEIPT_FIELDS:
        raise ValueError("review-complete requires the unchanged bridge confirmation receipt")
    request_id = value.get("request_id")
    decision = value.get("decision")
    if not isinstance(request_id, str) or not request_id or not isinstance(decision, dict):
        raise ValueError("invalid product review receipt")
    with lock(ws):
        packet = _packet(ws, value.get("packet_id"))
        current = approval_snapshot(ws)
        existing = _read(_path(ws))
        if existing.get(HOST_RECEIPT_KEY) == value and existing.get("state") == TIMEOUT_APPLIED:
            return status(ws, value["packet_id"])
        recovering = (existing.get(HOST_RECEIPT_KEY) == value
                      and existing.get("packet_id") == value["packet_id"]
                      and existing.get("state") == APPLYING_TIMEOUT
                      and current in (existing.get("snapshot"), existing.get("approval_snapshot")))
        if not recovering and (packet.get("snapshot") != current or value["snapshot_id"] != digest(current)):
            raise ValueError("product review receipt belongs to a stale outline or task")
        if existing.get("packet_id") == value["packet_id"] and existing.get(HOST_RECEIPT_KEY) not in (None, value):
            raise ValueError("a different product decision already completed this packet")
        if decision.get(HOST_CANCELLED_KEY):
            atomic_json(_path(ws), {"packet_id": value["packet_id"], "snapshot": current,
                                   "state": RESPONDED, HOST_RECEIPT_KEY: value})
            return {"status": "SUCCESS", "state": RESPONDED, "cancelled": True,
                    "can_continue": False, "next_action": "Review cancelled. Do not approve or start writing."}
        if decision.get(HOST_TIMEOUT_KEY):
            started = value["started_at"]
            deadline = value["deadline_at"]
            if (read_request(ws)["outline_review"] != TIMEOUT_MODE
                    or type(started) not in (int, float) or type(deadline) not in (int, float)
                    or not math.isfinite(started) or not math.isfinite(deadline)
                    or deadline - started != SECONDS or time.time() < deadline
                    or decision.get("answers")
                    or (existing.get("packet_id") == value["packet_id"] and existing.get("state") == RESPONDED)):
                raise ValueError("invalid or superseded product timeout receipt")
            if not recovering:
                atomic_json(_path(ws), {"packet_id": value["packet_id"], "snapshot": current,
                    "publication": packet["publication"], "state": WAITING,
                    "started_at": started, "deadline_at": deadline,
                    "display_message_id": request_id, HOST_RECEIPT_KEY: value})
        else:
            answers = decision.get("answers", {})
            answer = answers.get(request_id) if isinstance(answers, dict) else None
            if not isinstance(answer, str) or not answer.strip():
                raise ValueError("product review receipt has no actual answer")
            record_response_locked(ws, value["packet_id"], answer, request_id)
            state = _read(_path(ws))
            state.update(packet_id=value["packet_id"], snapshot=current, state=RESPONDED,
                         host_receipt=value, user_response=answer)
            atomic_json(_path(ws), state)
            return {"status": "SUCCESS", "state": RESPONDED, "packet_id": value["packet_id"],
                    "user_response": answer, "message_id": request_id, "can_continue": False,
                    "next_action": "Use writing approve only for actual confirmation. Apply revision or pause requests without approving."}
    return apply_timeout(ws, value["packet_id"])


def _packet(ws, packet_id):
    packet = _read(Path(ws) / "04_outline/review_packet.json")
    if not packet_id or packet.get("packet_id") != packet_id:
        raise ValueError(
            "review packet is missing or superseded; display the current outline review-packet"
        )
    return packet


def status(ws, packet_id):
    request = read_request(ws)
    if request["outline_review"] != TIMEOUT_MODE:
        return {"status": "SUCCESS", "state": NOT_ENABLED, "can_continue": False}
    packet = _packet(ws, packet_id)
    state = _read(_path(ws))
    current = approval_snapshot(ws)
    result = {
        "status": "SUCCESS",
        "packet_id": packet_id,
        "timeout_seconds": SECONDS,
        "can_continue": False,
    }
    receipt = _read(Path(ws) / "04_outline/approval.json")
    if valid_timeout_approval(ws, receipt, current):
        return {
            **result,
            "state": TIMEOUT_APPLIED,
            "can_continue": True,
            "decision_id": state["decision_id"],
            "notice_id": state["notice_id"],
            "notice": state["notice"],
            "publication": state["publication"],
            "next_action": "Deliver notice once using notice_id, then resume manuscript prepare for this decision_id; do not start a second generation branch.",
        }
    if (
        receipt.get("decision_source", USER_DECISION) == USER_DECISION
        and receipt.get("user_response")
        and receipt.get("snapshot") == current
    ):
        return {
            **result,
            "state": APPROVED,
            "can_continue": True,
            "next_action": "Continue with manuscript prepare.",
        }
    if state.get("packet_id") != packet_id:
        return {
            **result,
            "state": AWAITING_DISPLAY,
            "next_action": "Display the outline, recommended publication and five-minute notice, then call writing review-start.",
        }
    recovering = state.get("state") == APPLYING_TIMEOUT and current in (
        state.get("snapshot"),
        state.get("approval_snapshot"),
    )
    if not recovering and (packet.get("snapshot") != current or state.get("snapshot") != current):
        return {
            **result,
            "state": STALE,
            "next_action": "The task or outline changed. Display its current review-packet; do not apply the old deadline.",
        }
    if state.get("state") == RESPONDED:
        return {
            **result,
            "state": RESPONDED,
            "next_action": "Handle the actual user reply. Timer is cancelled; do not restart this packet automatically.",
        }
    if not _valid_window(state):
        raise ValueError("invalid review wait window; redisplay a fresh packet")
    remaining = max(0, math.ceil(state["deadline_at"] - time.time()))
    return {
        **result,
        "state": EXPIRED if remaining == 0 or recovering else WAITING,
        "started_at": state["started_at"],
        "deadline_at": state["deadline_at"],
        "deadline_utc": datetime.fromtimestamp(state["deadline_at"], timezone.utc).isoformat(),
        "remaining_seconds": remaining,
        "publication": state["publication"],
        "next_action": (
            "Process any received user input first; if none, call writing review-timeout --packet-id "
            + packet_id
            if remaining == 0 or recovering
            else "Keep an interruptible host wait active or call writing review-wait --packet-id "
            + packet_id
            + " --wait-seconds 30"
        ),
    }


def start(ws, value):
    if (
        not isinstance(value, dict)
        or set(value) - {"packet_id", "displayed", "message_id"}
        or value.get("displayed") is not True
    ):
        raise ValueError(
            "review-start requires packet_id and displayed:true after actually showing the outline and timeout notice"
        )
    if "message_id" in value and (
        not isinstance(value["message_id"], str) or not value["message_id"].strip()
    ):
        raise ValueError("message_id must be an actual nonempty host message ID, or omitted")
    with lock(ws):
        if read_request(ws)["outline_review"] != TIMEOUT_MODE:
            raise ValueError("review-start requires outline_review=timeout_auto")
        packet = _packet(ws, value.get("packet_id"))
        snapshot = approval_snapshot(ws)
        observed = status(ws, packet["packet_id"])
        if observed["can_continue"]:
            return observed
        if packet["snapshot"] != snapshot:
            raise ValueError("review packet is stale; display the current outline and settings")
        existing = _read(_path(ws))
        if existing.get("packet_id") == packet["packet_id"]:
            return status(ws, packet["packet_id"])  # Re-reading never resets the clock.
        validate_publication_choice(ws, packet["publication"])
        now = time.time()
        atomic_json(
            _path(ws),
            {
                "state": WAITING,
                "packet_id": packet["packet_id"],
                "snapshot": snapshot,
                "publication": packet["publication"],
                "started_at": now,
                "deadline_at": now + SECONDS,
                "display_message_id": value.get("message_id"),
            },
        )
        return status(ws, packet["packet_id"])


def record_response_locked(ws, packet_id, user_response, message_id=None):
    """Called immediately on arrival, before interpreting a choice/pause/revision."""
    state = _read(_path(ws))
    if state.get("packet_id") != packet_id:
        if read_request(ws)["outline_review"] != TIMEOUT_MODE:
            return NO_MATCHING_WAIT
        packet = _packet(ws, packet_id)
        state = {
            "packet_id": packet_id,
            "snapshot": packet["snapshot"],
            "publication": packet["publication"],
        }
    if state.get("state") == TIMEOUT_APPLIED:
        return LATE_RESPONSE
    if state.get("state") != RESPONDED:
        state.update(
            state=RESPONDED,
            user_response=user_response,
            response_message_id=message_id,
            responded_at=time.time(),
        )
        atomic_json(_path(ws), state)
    return RESPONDED


def response(ws, value):
    if not isinstance(value, dict) or set(value) - {"packet_id", "user_response", "message_id"}:
        raise ValueError(
            "review-response accepts packet_id, actual user_response and optional message_id"
        )
    text = value.get("user_response")
    if not isinstance(text, str) or not text.strip():
        raise ValueError(
            "review-response requires the actual nonempty user reply, including pause/revision requests"
        )
    with lock(ws):
        _packet(ws, value.get("packet_id"))
        state = record_response_locked(ws, value["packet_id"], text, value.get("message_id"))
        return {
            "status": "SUCCESS",
            "state": state,
            "packet_id": value["packet_id"],
            "next_action": (
                "Handle the reply as a follow-up without a second generation branch."
                if state == LATE_RESPONSE
                else "Timeout is stopped. Handle the user reply; use writing approve only for a real confirmation."
            ),
        }


def apply_timeout(ws, packet_id):
    with lock(ws):
        observed = status(ws, packet_id)
        if observed["state"] != EXPIRED:
            return {**observed, "did_apply": False}
        state = _read(_path(ws))
        validate_publication_choice(ws, state["publication"])
        if state["state"] != APPLYING_TIMEOUT:
            expected = deepcopy(state["snapshot"])
            expected["publication"] = state["publication"]
            chinese = expected["request"].get("language") == "CHINESE"
            choice = state["publication"]
            parts = ["PDF" if choice["format"] == "latex_pdf" else "Markdown"]
            if choice["format"] == "latex_pdf":
                parts.append(choice["template"] + (" 模板" if chinese else " template"))
            parts.append(style_labels(choice["citation_style"], expected["request"].get("language"))["timeout"])
            settings = ("、" if chinese else ", ").join(parts)
            notice = (
                "已等待 5 分钟，尚未收到回复。我已按此前展示的推荐设置继续："
                if chinese
                else "No reply was received within five minutes. Continuing with the previously displayed settings: "
            ) + settings
            state.update(
                state=APPLYING_TIMEOUT,
                decided_at=time.time(),
                approval_snapshot=expected,
                decision_id=uuid.uuid4().hex,
                notice_id="review-timeout:" + packet_id,
                notice=notice,
            )
            atomic_json(_path(ws), state)
        # Recover a crash between configuration and receipt writes using the
        # same decision ID; no models or generation jobs are launched here.
        configure(ws, {"publication": state["publication"]})
        current = approval_snapshot(ws)
        if current != state["approval_snapshot"]:
            raise ValueError("task changed during timeout resolution; do not continue")
        approval = {
            "status": "SUCCESS",
            "snapshot": current,
            "decision_source": TIMEOUT_DECISION,
            "decision_id": state["decision_id"],
            "source_packet_id": packet_id,
            "publication": state["publication"],
            "user_response": None,
            "decided_at": state["decided_at"],
            "notice_id": state["notice_id"],
            "notice": state["notice"],
        }
        atomic_json(Path(ws) / "04_outline/approval.json", approval)
        state["state"] = TIMEOUT_APPLIED
        atomic_json(_path(ws), state)
        return {**status(ws, packet_id), "did_apply": True}


def wait(ws, packet_id, seconds=WAIT_MAX_SECONDS):
    """Bounded polling for active agents; a host scheduler can use status instead."""
    if type(seconds) is not int or not 0 <= seconds <= WAIT_MAX_SECONDS:
        raise ValueError("review-wait --wait-seconds must be an integer from 0 to 30")
    end = time.monotonic() + seconds
    while True:
        result = status(ws, packet_id)
        remaining = end - time.monotonic()
        if result["state"] != WAITING or remaining <= 0:
            return result
        time.sleep(min(WAIT_POLL_SECONDS, remaining, result["remaining_seconds"]))


def dispatch(ws, action, value):
    if not isinstance(value, dict):
        raise ValueError("review input must be an object")
    if action == "review-start":
        return start(ws, value)
    if action == "review-complete":
        return complete(ws, value)
    if action == "review-response":
        return response(ws, value)
    allowed = {"packet_id", "wait_seconds"} if action == "review-wait" else {"packet_id"}
    if (
        set(value) - allowed
        or not isinstance(value.get("packet_id"), str)
        or not value["packet_id"].strip()
    ):
        raise ValueError(
            action + " requires an actual packet_id; allowed fields: " + ", ".join(sorted(allowed))
        )
    if action == "review-status":
        return status(ws, value["packet_id"])
    if action == "review-wait":
        return wait(ws, value["packet_id"], value.get("wait_seconds", WAIT_MAX_SECONDS))
    if action == "review-timeout":
        return apply_timeout(ws, value["packet_id"])
    raise ValueError("unknown review action")
