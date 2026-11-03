"""Project a skill review packet into a product-owned decision request."""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from service.literature.persistence.files import read_scoped_file, scoped_workspace_path
from service.literature.service.review import REVIEW_FILE_BYTES

REVIEW_PACKET = "04_outline/review_packet.json"
OUTLINE_CHECKPOINT = "outline"
REVIEW_TIMEOUT_MODE = "timeout_auto"
REVIEW_REQUIRED_MODE = "required"
REVIEW_TIMEOUT_SECONDS = 300
REVIEW_SKIP_STATES = frozenset(("auto", "approved", "timeout_applied"))
REVIEW_WAIT_STATES = frozenset(("required", "awaiting_display", "waiting", "expired"))
REVIEW_CONFIRM_LABEL = "按当前方案开始撰写"
REVIEW_HEADER = "大纲与输出设置确认"
REVIEW_QUESTION = "是否按上述大纲和以下输出设置开始撰写？也可直接填写大纲或输出设置的修改意见。"
REVIEW_TIMEOUT_NOTICE = "请在 5 分钟内确认或提出修改；若未回复，将按以上设置继续。"
REVIEW_NEXT_ACTION = (
    "The product card has already received the user's decision. Execute continuation.steps "
    "in order using this workspace's slr CLI: append each arguments array, and send input "
    "as JSON on stdin (--request -). Use the actual session workdir, not a reconstructed path. "
    "Stop on a failed step; repair that failure without asking for the same confirmation again. "
    "If continuation.state is confirmed, the click is the actual user approval: after both "
    "steps succeed, continue the Skill's manuscript preparation and writing in this turn. "
    "Do not finish with an outline summary or ask for a text confirmation. "
    "Otherwise consume review-complete and follow its result; never approve revisions, "
    "cancellation or timeout as a user confirmation. Do not start another question or timer."
)
REVIEW_CONFIRMED_STATE = "confirmed"
REVIEW_DECISION_STATE = "decision_received"
REVIEW_COMPLETE_ARGUMENTS = ("writing", "review-complete", "--request", "-")
REVIEW_APPROVE_ARGUMENTS = ("writing", "approve", "--request", "-")


def confirmation_continuation(confirmation: dict[str, Any]) -> dict[str, Any]:
    decision = confirmation["decision"]
    request_id = confirmation["request_id"]
    answer = decision.get("answers", {}).get(request_id)
    confirmed = (
        answer == REVIEW_CONFIRM_LABEL
        and not decision.get("cancelled")
        and not decision.get("timed_out")
    )
    steps = [{"arguments": list(REVIEW_COMPLETE_ARGUMENTS), "input": confirmation}]
    if confirmed:
        steps.append(
            {
                "arguments": list(REVIEW_APPROVE_ARGUMENTS),
                "input": {
                    "packet_id": confirmation["packet_id"],
                    "message_id": request_id,
                    "user_response": answer,
                },
            }
        )
    return {
        "state": REVIEW_CONFIRMED_STATE if confirmed else REVIEW_DECISION_STATE,
        "steps": steps,
    }


@dataclass(frozen=True)
class OutlineConfirmation:
    packet_id: str
    digest: str
    snapshot_id: str
    question: dict[str, Any] | None
    timeout_seconds: int | None


def prepare_confirmation(
    workdir: Path, workspace: str, session_id: str, turn_id: str
) -> OutlineConfirmation:
    raw = read_scoped_file(
        workdir, scoped_workspace_path(workspace, REVIEW_PACKET), REVIEW_FILE_BYTES
    )
    packet = json.loads(raw)
    packet_id = packet.get("packet_id")
    confirmation = packet.get("confirmation", {})
    state = confirmation.get("state")
    mode = packet.get("outline_review")
    if not isinstance(packet_id, str) or not packet_id.strip():
        raise ValueError("review_packet_identity_missing")
    digest = sha256(raw).hexdigest()
    snapshot_id = sha256(
        json.dumps(
            packet.get("snapshot"), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    if state in REVIEW_SKIP_STATES:
        return OutlineConfirmation(packet_id, digest, snapshot_id, None, None)
    if state not in REVIEW_WAIT_STATES or mode not in {REVIEW_TIMEOUT_MODE, REVIEW_REQUIRED_MODE}:
        raise ValueError("review_packet_not_awaiting_confirmation")
    settings = packet.get("publication_display", {})
    if not all(
        isinstance(settings.get(key), str) and settings[key] for key in ("format", "citation_style")
    ):
        raise ValueError("review_publication_display_missing")
    timeout = REVIEW_TIMEOUT_SECONDS if mode == REVIEW_TIMEOUT_MODE else None
    identity = sha256(
        json.dumps([session_id, turn_id, workspace, packet_id, digest]).encode()
    ).hexdigest()
    question = {
        "id": f"outline-review:{identity}",
        "header": REVIEW_HEADER,
        "question": "\n\n".join(
            filter(
                None,
                (
                    REVIEW_QUESTION,
                    f"输出格式：{settings['format']}；引用样式：{settings['citation_style']}。",
                    (
                        REVIEW_TIMEOUT_NOTICE
                        if timeout
                        else "请确认或提出修改，收到确认后才会开始撰写。"
                    ),
                ),
            )
        ),
        "options": [{"label": REVIEW_CONFIRM_LABEL, "description": "使用当前大纲和输出设置。"}],
    }
    return OutlineConfirmation(packet_id, digest, snapshot_id, question, timeout)
