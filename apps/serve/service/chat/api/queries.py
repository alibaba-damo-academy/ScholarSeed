"""Shared admission for bounded current-project read operations."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN, HTTP_413_CONTENT_TOO_LARGE

from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import BRIDGE_REQUESTS
from service.platform.queries import PROJECT_REQUIRED, ProjectQueryError
from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
)

QUERY_DENIED = "bridge_access_denied"
QUERY_INVALID = "bridge_invalid_parameters"
QUERY_FAILED = "bridge_query_failed"
QUERY_TOO_LARGE = "bridge_response_too_large"


def register_project_queries(
    app: FastAPI,
    sessions: SessionService,
    handlers: Mapping[tuple[str, str], Callable[[str, Any], BaseModel]],
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    def endpoint(key: tuple[str, str], handler: Callable[[str, Any], BaseModel]):
        async def query(request: Request) -> JSONResponse:
            live = bridge_caller(request, sessions)
            if live is None or not live.ledger.active_turn_id:
                return JSONResponse({"ok": False, "error": QUERY_DENIED}, HTTP_403_FORBIDDEN)
            project_id = live.project_id
            if not project_id:
                return JSONResponse({"ok": False, "error": PROJECT_REQUIRED}, HTTP_400_BAD_REQUEST)
            turn_id = live.ledger.active_turn_id
            generation = live.attachment_generation
            activity = live.turn_activity

            def active() -> bool:
                return (
                    sessions.bridge_caller(live.id) is live
                    and live.project_id == project_id
                    and live.ledger.active_turn_id == turn_id
                    and live.attachment_generation == generation
                    and live.turn_activity is activity
                )

            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                    return JSONResponse(
                        {"ok": False, "error": QUERY_INVALID}, HTTP_413_CONTENT_TOO_LARGE
                    )
            try:
                command = BRIDGE_REQUESTS[key].request_type.model_validate(json.loads(raw))
            except (ValueError, ValidationError):
                return JSONResponse({"ok": False, "error": QUERY_INVALID}, HTTP_400_BAD_REQUEST)
            if not active():
                return JSONResponse({"ok": False, "error": QUERY_DENIED}, HTTP_403_FORBIDDEN)
            try:
                result = await activities.to_thread(
                    ActivityDomain.BRIDGE, handler, project_id, command
                )
            except ProjectQueryError as error:
                return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
            except OSError:
                return JSONResponse({"ok": False, "error": QUERY_FAILED}, HTTP_400_BAD_REQUEST)
            if not active():
                return JSONResponse({"ok": False, "error": QUERY_DENIED}, HTTP_403_FORBIDDEN)
            response = JSONResponse(result.model_dump(mode="json"))
            if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
                return JSONResponse({"ok": False, "error": QUERY_TOO_LARGE}, HTTP_400_BAD_REQUEST)
            return response

        return query

    for key, handler in handlers.items():
        router.add_api_route(BRIDGE_REQUESTS[key].route, endpoint(key, handler), methods=["POST"])
    app.include_router(router)
    return router
