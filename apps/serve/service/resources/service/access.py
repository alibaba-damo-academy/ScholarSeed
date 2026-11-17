"""Task-scoped external file approval using the existing durable product HIL ledger."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Callable

from scholarseed_runtime.contract.permission import RuntimePermissionMode
from service.chat.constants import PRODUCT_DECISION_SOURCE, PRODUCT_INTERACTION_HOST_RESPONSE
from service.chat.persistence.catalog import SessionStateConflictError
from service.chat.runtime.live import LiveSession
from service.content.domain.model import ContentError
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    RESOURCE_READ_ENCODING_TEXT,
    ResourceExternalRead,
    ResourceExternalReadResult,
)
from service.platform.content import ContentPort

EXTERNAL_READ_PREFIX = "external-read:"
EXTERNAL_READ_HEADER = "external_file_read"
EXTERNAL_READ_ALLOW = "allow_file_read"
EXTERNAL_READ_DENY = "deny_file_read"
EXTERNAL_READ_DENIED = "external_read_denied"
EXTERNAL_READ_STALE = "external_read_scope_expired"
EXTERNAL_READ_CHANGED = "external_file_changed"
EXTERNAL_READ_EVENT = "resource.external_read"
EXTERNAL_READ_REVISION = "file_revision"
EXTERNAL_READ_AUTOMATIC = "automatic_file_policy"
EXTERNAL_READ_DECISION_SOURCE = "agent"
PATH_TOKEN_CHARACTERS = r"A-Za-z0-9_/\\.\-"


class ExternalReadDenied(ContentError):
    pass


def explicitly_requested(path: str, text: str) -> bool:
    return bool(
        re.search(
            rf"(?<![{PATH_TOKEN_CHARACTERS}]){re.escape(path)}(?![{PATH_TOKEN_CHARACTERS}])", text
        )
    )


async def read_external(
    live: LiveSession,
    query: ResourceExternalRead,
    content: ContentPort,
    activities: Activities,
    active: Callable[[], bool],
    user_message: Callable[[str, str], str] | None,
) -> ResourceExternalReadResult:
    turn_id = live.ledger.active_turn_id
    generation = (
        live.active_product_turn_id,
        live.last_submission_id,
        live.interrupt_generation,
        live.attachment_generation,
    )

    def current() -> bool:
        return (
            active()
            and not live.terminating
            and not live.terminated
            and generation
            == (
                live.active_product_turn_id,
                live.last_submission_id,
                live.interrupt_generation,
                live.attachment_generation,
            )
        )

    if not current():
        raise ExternalReadDenied(EXTERNAL_READ_STALE)
    snapshot = await activities.to_thread(
        ActivityDomain.BRIDGE, content.external_file_snapshot, query.path
    )
    identity = (live.id, live.bridge_token, turn_id, generation, snapshot.path)
    request_id = EXTERNAL_READ_PREFIX + hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    question = {
        "id": request_id,
        "header": EXTERNAL_READ_HEADER,
        "question": snapshot.path,
        EXTERNAL_READ_REVISION: snapshot.revision,
        PRODUCT_INTERACTION_HOST_RESPONSE: True,
        "options": [{"label": EXTERNAL_READ_ALLOW}, {"label": EXTERNAL_READ_DENY}],
    }
    text = (
        await activities.to_thread(ActivityDomain.BRIDGE, user_message, live.id, turn_id)
        if user_message
        else ""
    )
    explicit = explicitly_requested(query.path, text)

    def automatic_decision() -> dict | None:
        if not current():
            return None
        mode = live.applied_permission_mode
        if mode == RuntimePermissionMode.BYPASS.value or (
            mode == RuntimePermissionMode.SAFE_AUTO.value
            and snapshot.automatic_eligible
            and explicit
        ):
            return {
                "answers": {request_id: EXTERNAL_READ_ALLOW},
                PRODUCT_DECISION_SOURCE: EXTERNAL_READ_DECISION_SOURCE,
                "values": {"approval_source": EXTERNAL_READ_AUTOMATIC, "permission_mode": mode},
            }
        return None

    if not current():
        raise ExternalReadDenied(EXTERNAL_READ_STALE)
    try:
        with activities.continue_from(live.turn_activity, ActivityDomain.BRIDGE) as activity:
            decision = await live.interactions.request_product_input(
                question,
                turn_id=turn_id,
                item_id=request_id,
                activity=activity,
                automatic_decision=automatic_decision,
            )
    except SessionStateConflictError as error:
        raise ContentError(EXTERNAL_READ_CHANGED) from error
    if not current():
        raise ExternalReadDenied(EXTERNAL_READ_STALE)
    if decision.get("cancelled") or decision.get("answers") != {request_id: EXTERNAL_READ_ALLOW}:
        raise ExternalReadDenied(EXTERNAL_READ_DENIED)
    payload = await activities.to_thread(
        ActivityDomain.BRIDGE, content.read_external_file, snapshot, query.offset, query.limit
    )
    if not current():
        raise ExternalReadDenied(EXTERNAL_READ_STALE)
    if query.encoding == RESOURCE_READ_ENCODING_TEXT:
        try:
            value = payload.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ContentError("not_text_file") from error
    else:
        value = base64.b64encode(payload).decode("ascii")
    await live.publish(
        EXTERNAL_READ_EVENT,
        {
            "path": snapshot.path,
            "offset": query.offset,
            "bytes": len(payload),
            "request_id": request_id,
            "revision": snapshot.revision,
        },
        turn_id=turn_id,
    )
    return ResourceExternalReadResult(
        path=snapshot.path,
        offset=query.offset,
        size=snapshot.size,
        media_type=snapshot.media_type,
        revision=snapshot.revision,
        encoding=query.encoding,
        content=value,
        eof=query.offset + len(payload) >= snapshot.size,
    )
