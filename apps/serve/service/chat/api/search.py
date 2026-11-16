"""Authenticated turn-bound web search without shell-output provenance."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.status import (
    HTTP_200_OK,
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_502_BAD_GATEWAY,
)

from scholarseed_runtime.contract import RuntimePermissionMode
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.constants import PRODUCT_EVENT_SOURCE_CANDIDATES
from service.chat.persistence.catalog import SessionPrincipal
from service.chat.service.retry import (
    RECOVERY_IDENTIFIER_LIMIT,
    RECOVERY_STALE,
    RECOVERY_UNSUPPORTED,
)
from service.chat.service.search import (
    SEARCH_PROFILES,
    SEARCH_REQUEST_ERRORS,
    SearchError,
    SearchInterrupted,
    SearchService,
)
from service.chat.service.sessions import SessionService
from service.identity.utils import request_owner_id, request_user_id
from service.invocation.service.artifacts import InvocationArtifactError
from service.invocation.service.runtime import INVOCATION_PERMISSION_EXCEEDS_PARENT, InvocationError
from service.invocation.service.skills import InvocationSkillError, InvocationSkillRuntimeError
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    SEARCH_ROUTE,
    WebSearchRequest,
)

LOGGER = logging.getLogger(__name__)
SEARCH_REQUEST_INVALID = "search_request_invalid"
SEARCH_UNKNOWN_PROFILE = "unknown"
TOOL_RECOVERY_ROUTE = "/api/serve/sessions/{session_id}/tools/recovery"
TOOL_RECOVERY_APPROVAL_REQUIRED = "tool_recovery_approval_required"


class ToolRecoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    turn_id: str = Field(min_length=1, max_length=RECOVERY_IDENTIFIER_LIMIT)
    tool_id: str = Field(min_length=1, max_length=RECOVERY_IDENTIFIER_LIMIT)
    request_id: str = Field(
        min_length=1, max_length=RECOVERY_IDENTIFIER_LIMIT, pattern=r"^[A-Za-z0-9_-]+$"
    )
    approved: bool = False


def register_conversation_search_routes(
    app: FastAPI,
    sessions: SessionService,
    searches: SearchService,
    can_search: Callable[[str, str], bool],
    *,
    activities: Activities,
    admit_search: Callable[[Any], None] | None = None,
) -> APIRouter:
    def require_recovery_access(session_id: str, request: Request) -> None:
        sessions.require_access(session_id, SessionPrincipal(user_id=request_owner_id(request)))

    @app.get(TOOL_RECOVERY_ROUTE, dependencies=[Depends(require_recovery_access)])
    async def recoverable_tools(session_id: str, turn_id: str) -> JSONResponse:
        return JSONResponse({"tool_ids": sessions.recoverable_tools(session_id, turn_id)})

    @app.post(TOOL_RECOVERY_ROUTE, dependencies=[Depends(require_recovery_access)])
    async def retry_tool(session_id: str, request: Request) -> JSONResponse:
        raw = await request.body()
        try:
            command = ToolRecoveryRequest.model_validate_json(raw)
        except ValidationError:
            return JSONResponse(
                {"ok": False, "error": SEARCH_REQUEST_INVALID}, HTTP_400_BAD_REQUEST
            )
        if not command.approved:
            return JSONResponse(
                {"ok": False, "error": TOOL_RECOVERY_APPROVAL_REQUIRED}, HTTP_403_FORBIDDEN
            )
        if sessions.is_readonly(session_id):
            return JSONResponse({"ok": False, "error": RECOVERY_STALE}, HTTP_403_FORBIDDEN)
        actor = request_user_id(request)
        if actor:
            await sessions.align_metering_identity(session_id, actor)
        try:
            result = await sessions.retry_tool(
                session_id,
                turn_id=command.turn_id,
                tool_id=command.tool_id,
                request_id=command.request_id,
                searches=searches,
                can_search=can_search,
            )
        except ValueError as error:
            code = (
                str(error)
                if str(error) in {RECOVERY_STALE, RECOVERY_UNSUPPORTED}
                else RECOVERY_UNSUPPORTED
            )
            return JSONResponse({"ok": False, "error": code}, HTTP_400_BAD_REQUEST)
        return JSONResponse(result)

    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(SEARCH_ROUTE)
    async def search(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        record = live.catalog.get(live.id)
        if record is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        generation = live.interrupt_generation
        attachment = live.attachment_generation

        def current() -> bool:
            return (
                sessions.bridge_caller(live.id) is live
                and live.publication_turn_id == turn_id
                and live.interrupt_generation == generation
                and live.attachment_generation == attachment
            )

        if not current() or not can_search(live.id, turn_id):
            return JSONResponse({"ok": False, "error": "search_not_allowed"}, HTTP_403_FORBIDDEN)
        if admit_search is not None:
            try:
                await activities.to_thread(ActivityDomain.BRIDGE, admit_search, live)
            except (ValueError, OSError) as error:
                return JSONResponse(
                    {
                        "ok": False,
                        "status": "action_required",
                        "error": "search_plan_required",
                        "next_action": str(error),
                    },
                    HTTP_403_FORBIDDEN,
                )
            if not current():
                return JSONResponse(
                    {"ok": False, "error": "search_not_allowed"}, HTTP_403_FORBIDDEN
                )
        raw = await request.body()

        async def publish(result: dict) -> None:
            if not current():
                raise SearchInterrupted()
            await live.publish(
                PRODUCT_EVENT_SOURCE_CANDIDATES,
                {
                    "search_id": result["search_id"],
                    "provider": result["provider"],
                    "query": result["query"],
                    "purpose": command.purpose.strip(),
                    "results": result["candidates"],
                    "result_count": len(result["candidates"]),
                    "results_truncated": result["truncated"],
                },
                turn_id=turn_id,
                item_id=result["search_id"],
                idempotency_key=f"search:{turn_id}:{result['search_id']}",
            )

        try:
            command = WebSearchRequest.model_validate(json.loads(raw))
        except (ValidationError, json.JSONDecodeError, UnicodeDecodeError, RecursionError):
            return JSONResponse(
                {"ok": False, "status": "failed", "error": SEARCH_REQUEST_INVALID},
                HTTP_400_BAD_REQUEST,
            )

        if current():
            response_status = HTTP_200_OK
            try:
                mode = RuntimePermissionMode(
                    live.applied_permission_mode or RuntimePermissionMode.ASK.value
                )
                result = await searches.run(
                    command,
                    owner_id=record.principal_id,
                    user_id=live.user_id,
                    permission=live.permission_intent(mode),
                    current=current,
                    publish=publish,
                )
            except SearchInterrupted:
                return JSONResponse(
                    {"ok": False, "status": "interrupted", "error": "search_interrupted"}
                )
            except InvocationError as error:
                status = (
                    "action_required"
                    if error.code == INVOCATION_PERMISSION_EXCEEDS_PARENT
                    else "failed"
                )
                result = {"ok": False, "status": status, "error": error.code}
            except InvocationSkillError as error:
                result = {"ok": False, "status": "action_required", "error": error.code}
            except (InvocationArtifactError, InvocationSkillRuntimeError) as error:
                result = {"ok": False, "status": "failed", "error": error.code}
            except SearchError as error:
                LOGGER.warning(
                    "search_validation_failed session_id=%s turn_id=%s profile=%s invocation_id=%s code=%s",
                    live.id,
                    turn_id,
                    (
                        command.profile
                        if command.profile in SEARCH_PROFILES
                        else SEARCH_UNKNOWN_PROFILE
                    ),
                    error.invocation_id,
                    error.code.value,
                )
                result = {
                    "ok": False,
                    "status": "failed",
                    "error": error.code.value,
                    "invocation_id": error.invocation_id,
                }
                if error.code in SEARCH_REQUEST_ERRORS:
                    return JSONResponse(result, HTTP_400_BAD_REQUEST)
                response_status = HTTP_502_BAD_GATEWAY
            return JSONResponse(result, response_status)
        return JSONResponse({"ok": False, "status": "interrupted", "error": "search_interrupted"})

    app.include_router(router)
    return router
