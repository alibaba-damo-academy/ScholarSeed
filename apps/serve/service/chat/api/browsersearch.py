"""Product browser fallback for an authenticated search Invocation."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from scholarseed_runtime.contract import RuntimePermissionMode
from service.chat.api.bridge import scoped_bridge_admission, scoped_bridge_caller
from service.chat.service.browserhost import BrowserHostClient
from service.invocation.service.runtime import InvocationService, OneShotExecution
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    SEARCH_BROWSER_GUIDANCE,
    SEARCH_BROWSER_ROUTE,
    BrowserSearchRequest,
)
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES

SEARCH_BROWSER_SKILLS = {
    "builtin:web-search": frozenset({"browser", "automatic", "fallback"}),
    "builtin:fast-search": frozenset({""}),
}
SEARCH_BROWSER_PERMISSION_MODES = frozenset(
    mode.value
    for mode in (
        RuntimePermissionMode.ASK,
        RuntimePermissionMode.SAFE_AUTO,
        RuntimePermissionMode.BYPASS,
    )
)
SEARCH_BROWSER_POLL_SECONDS = 0.25
SEARCH_BROWSER_SCOPE_EPOCH = 1
SEARCH_BROWSER_INTERRUPT_GENERATION = 0
SEARCH_BROWSER_ACTION_REQUIRED = "browser_search_authorization_required"
SEARCH_BROWSER_DENIED = "browser_search_not_allowed"
SEARCH_BROWSER_RESPONSE_PREFIX = "web-search-browser-response-"
SEARCH_BROWSER_RESPONSE_SUFFIX = ".json"
SEARCH_BROWSER_ENCODING = "utf-8"
logger = logging.getLogger(__name__)


def search_invocation_allowed(execution: OneShotExecution) -> bool:
    skill = execution.record.skill
    profiles = SEARCH_BROWSER_SKILLS.get(skill.get("id", ""), frozenset())
    return (
        not execution.closed.is_set()
        and bool(execution.publication_turn_id)
        and skill.get("profile", "") in profiles
        and execution.record.execution.get("permission_mode") in SEARCH_BROWSER_PERMISSION_MODES
    )


def register_browser_search_routes(
    app: FastAPI, invocations: InvocationService, host: BrowserHostClient, *, activities: Activities
) -> APIRouter:
    router = APIRouter(
        dependencies=[Depends(scoped_bridge_admission(invocations.bridge_caller, activities))]
    )

    @router.post(SEARCH_BROWSER_ROUTE)
    async def browser_search(request: Request) -> JSONResponse:
        execution = scoped_bridge_caller(request, invocations.bridge_caller)
        if execution is None or not search_invocation_allowed(execution):
            return JSONResponse(
                {"ok": False, "error": SEARCH_BROWSER_DENIED, "guidance": SEARCH_BROWSER_GUIDANCE},
                status_code=403,
            )
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, status_code=400
                )
        try:
            command = BrowserSearchRequest.model_validate_json(raw)
        except ValidationError:
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, status_code=400
            )
        if not command.query.strip():
            return JSONResponse({"ok": False, "error": "invalid_query"}, status_code=400)
        turn_id = execution.publication_turn_id

        def current() -> bool:
            return (
                invocations.bridge_caller(execution.id) is execution
                and search_invocation_allowed(execution)
                and execution.publication_turn_id == turn_id
            )

        async with execution.browser_search_lock:
            if not current():
                return JSONResponse({"ok": False, "error": "stale_scope"})
            execution.browser_search_generation += 1
            scope = {
                "session_id": execution.id,
                "instance_id": execution.id,
                "product_turn_id": turn_id,
                "turn_id": turn_id,
                "generation": execution.browser_search_generation,
                "interrupt_generation": SEARCH_BROWSER_INTERRUPT_GENERATION,
                "lifecycle_epoch": SEARCH_BROWSER_SCOPE_EPOCH,
            }
            request_id = uuid.uuid4().hex
            task = None
            scope_started = False
            result = {"ok": False, "error": "browser_unavailable"}
            try:
                started = await host.start_scope(**scope)
                scope_started = started.get("ok") is True
                if started.get("ok") is not True:
                    result = started
                elif current():
                    task = asyncio.create_task(
                        host.search(
                            **scope,
                            request_id=request_id,
                            engine=command.engine,
                            query=command.query.strip(),
                            limit=command.limit,
                        )
                    )
                    while not task.done():
                        if not current() or await request.is_disconnected():
                            result = {"ok": False, "error": "request_unknown"}
                            break
                        await asyncio.wait({task}, timeout=SEARCH_BROWSER_POLL_SECONDS)
                    else:
                        result = (
                            task.result() if current() else {"ok": False, "error": "stale_scope"}
                        )
            finally:
                if task is not None and not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                ended = await host.end_scope(**scope)
                if scope_started and ended.get("ok") is not True:
                    result = {"ok": False, "error": "request_unknown"}
            if result.get("error") == SEARCH_BROWSER_ACTION_REQUIRED:
                result = {**result, "status": "action_required"}
            if current():
                response_name = (
                    f"{SEARCH_BROWSER_RESPONSE_PREFIX}{request_id}{SEARCH_BROWSER_RESPONSE_SUFFIX}"
                )
                await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    (execution.workspace / response_name).write_text,
                    json.dumps(result, ensure_ascii=False),
                    encoding=SEARCH_BROWSER_ENCODING,
                )
                if current():
                    result = {**result, "response_path": response_name}
                else:
                    result = {"ok": False, "error": "stale_scope"}
            logger.info(
                "browser_search_finished invocation_id=%s request_id=%s ok=%s error=%s",
                execution.id,
                request_id,
                result.get("ok"),
                result.get("error", ""),
            )
            return JSONResponse(result)

    app.include_router(router)
    return router
