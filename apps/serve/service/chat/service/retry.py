"""Replay eligible read-only product searches from their durable execution record."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping
from enum import StrEnum

from scholarseed_runtime.contract import RuntimePermissionMode
from service.chat.constants import (
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
)
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import EXECUTION_BATCH_FIELD
from service.chat.runtime.tools import SERVICE_BRIDGE_TOOL_NAME
from service.chat.service.search import SearchError, SearchService
from service.invocation.service.artifacts import InvocationArtifactError
from service.invocation.service.runtime import InvocationError
from service.invocation.service.skills import InvocationSkillError, InvocationSkillRuntimeError
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import WebSearchRequest

RECOVERY_UNSUPPORTED = "tool_recovery_unsupported"
RECOVERY_STALE = "tool_recovery_stale"
RECOVERY_PREFIX = "tool-retry"
RECOVERY_TARGET_FIELD = "retry_of"
RECOVERY_EVENT_KINDS = (PRODUCT_EVENT_TOOL_STARTED, PRODUCT_EVENT_TOOL_COMPLETED)
RECOVERY_IDENTIFIER_LIMIT = 256
SEARCH_RECOVERY_OPERATION = ("search", "run")


class RecoveryState(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"
    UNKNOWN = "outcome_unknown"


def search_recovery_command(
    records: Iterable[ProductEventRecord], tool_id: str
) -> WebSearchRequest:
    started = None
    completed = None
    for record in records:
        if record.payload.get("tool_id") != tool_id:
            continue
        if record.kind == PRODUCT_EVENT_TOOL_STARTED:
            started = record
        elif record.kind == PRODUCT_EVENT_TOOL_COMPLETED:
            completed = record
    if started is None or completed is None or completed.payload.get("success") is not False:
        raise ValueError(RECOVERY_UNSUPPORTED)
    source = started.payload
    if source.get(RECOVERY_TARGET_FIELD):
        raise ValueError(RECOVERY_UNSUPPORTED)
    arguments = source.get("input")
    if source.get("name") != SERVICE_BRIDGE_TOOL_NAME or not isinstance(arguments, Mapping):
        raise ValueError(RECOVERY_UNSUPPORTED)
    if (arguments.get("capability"), arguments.get("operation")) != SEARCH_RECOVERY_OPERATION:
        raise ValueError(RECOVERY_UNSUPPORTED)
    return WebSearchRequest.model_validate(arguments.get("request"))


async def recover_search(
    live: LiveSession,
    events: ProductEventStore,
    searches: SearchService,
    activities: Activities,
    *,
    turn_id: str,
    tool_id: str,
    request_id: str,
    current: Callable[[], bool],
) -> dict:
    if not current():
        raise ValueError(RECOVERY_STALE)
    records = await activities.to_thread(
        ActivityDomain.RESOURCE,
        events.turn_records,
        live.id,
        turn_id,
        None,
        kinds=RECOVERY_EVENT_KINDS,
    )
    command = search_recovery_command(records, tool_id)
    key = f"{RECOVERY_PREFIX}:{turn_id}:{tool_id}:{request_id}"
    attempt_id = f"{RECOVERY_PREFIX}:{hashlib.sha256(key.encode()).hexdigest()}"
    attempts = {
        record.payload["tool_id"]: record
        for record in records
        if record.kind == PRODUCT_EVENT_TOOL_STARTED
        and record.payload.get(RECOVERY_TARGET_FIELD) == tool_id
    }
    completions = {
        record.payload["tool_id"]: record
        for record in records
        if record.kind == PRODUCT_EVENT_TOOL_COMPLETED
    }
    for identity in attempts:
        terminal = completions.get(identity)
        if terminal is not None and (identity == attempt_id or terminal.payload.get("success")):
            return {
                "ok": bool(terminal.payload.get("success")),
                "status": (
                    RecoveryState.COMPLETED
                    if terminal.payload.get("success")
                    else RecoveryState.FAILED
                ),
                "tool_id": identity,
            }
        if terminal is None:
            return {"ok": False, "status": RecoveryState.UNKNOWN, "tool_id": identity}
    source = next(
        record
        for record in records
        if record.kind == PRODUCT_EVENT_TOOL_STARTED and record.payload.get("tool_id") == tool_id
    )
    record = live.catalog.get(live.id)
    if record is None or not current():
        raise ValueError(RECOVERY_STALE)
    await live.publish(
        PRODUCT_EVENT_TOOL_STARTED,
        {
            "tool_id": attempt_id,
            "name": source.payload["name"],
            "input": source.payload["input"],
            RECOVERY_TARGET_FIELD: tool_id,
            EXECUTION_BATCH_FIELD: source.payload.get(EXECUTION_BATCH_FIELD),
        },
        turn_id=turn_id,
        item_id=attempt_id,
        idempotency_key=f"{key}:start",
    )

    async def publish(result: dict) -> None:
        if not current():
            raise ValueError(RECOVERY_STALE)
        await live.publish(
            PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
            {
                "search_id": result["search_id"],
                "query": command.query,
                "action": {"type": "search", "query": command.query},
                "results": result["candidates"],
                "result_count": len(result["candidates"]),
            },
            turn_id=turn_id,
            item_id=result["search_id"],
            idempotency_key=f"{key}:results",
        )

    mode = RuntimePermissionMode(live.applied_permission_mode or RuntimePermissionMode.ASK.value)
    try:
        result = await searches.run(
            command,
            owner_id=record.principal_id,
            user_id=live.user_id,
            permission=live.permission_intent(mode),
            current=current,
            publish=publish,
        )
    except (
        SearchError,
        InvocationError,
        InvocationArtifactError,
        InvocationSkillError,
        InvocationSkillRuntimeError,
    ) as error:
        result = {"ok": False, "error": str(error.code)}
    await live.publish(
        PRODUCT_EVENT_TOOL_COMPLETED,
        {
            "tool_id": attempt_id,
            "success": result.get("ok") is True,
            "output": json.dumps(result, ensure_ascii=False),
        },
        turn_id=turn_id,
        item_id=attempt_id,
        idempotency_key=f"{key}:done",
    )
    return {
        "ok": result.get("ok") is True,
        "status": RecoveryState.COMPLETED if result.get("ok") is True else RecoveryState.FAILED,
        "tool_id": attempt_id,
    }
