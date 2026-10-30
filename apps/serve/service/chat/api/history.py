"""Capability-authenticated history reads for the product's internal CLI."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
)

from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.constants import PRODUCT_EVENT_HISTORY_RETRIEVED
from service.chat.service.history import HistoryError, HistoryService
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities
from service.platform.bridge import (
    HISTORY_REQUESTS,
    HISTORY_ROUTE_PREFIX,
)
from service.platform.context import HistoryScopeSource
from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
)


def register_history_routes(
    app: FastAPI,
    sessions: SessionService,
    history: HistoryService,
    scope: HistoryScopeSource,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(HISTORY_ROUTE_PREFIX + "{operation}")
    async def query_history(operation: str, request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        session_id = live.id
        request_type = HISTORY_REQUESTS.get(operation)
        if request_type is None:
            return JSONResponse(
                {"ok": False, "error": "bridge_operation_unknown"}, HTTP_400_BAD_REQUEST
            )
        snapshot_id = live.active_assistant_snapshot_id
        turn_id = live.ledger.active_turn_id
        activity = live.turn_activity
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"},
                    HTTP_413_CONTENT_TOO_LARGE,
                )
        try:
            query = request_type.model_validate(json.loads(raw))
        except (ValueError, ValidationError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        # No await between checking active scope and reading: admission cannot switch turns here.
        if (
            sessions.bridge_caller(session_id) is not live
            or live.active_assistant_snapshot_id != snapshot_id
            or live.ledger.active_turn_id != turn_id
            or live.turn_activity is not activity
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            query_scope = scope.history_scope(session_id, snapshot_id)
            if query_scope is None:
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            result = history.query(session_id, query_scope, query)
        except HistoryError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        response = JSONResponse(result)
        if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
            return JSONResponse(
                {"ok": False, "error": "bridge_response_too_large; reduce limit"},
                HTTP_400_BAD_REQUEST,
            )
        await live.publish(
            PRODUCT_EVENT_HISTORY_RETRIEVED,
            {"operation": operation, "snapshot_id": snapshot_id, **result},
            turn_id=turn_id,
            idempotency_key=f"history:{uuid.uuid4().hex}",
        )
        return response

    app.include_router(router)
    return router
