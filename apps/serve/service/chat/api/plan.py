"""Authenticated plan operations for the current product execution scope."""

from __future__ import annotations

import json

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN, HTTP_409_CONFLICT

from service.chat.api.bridge import bridge_caller
from service.chat.service.plan import PlanConflict
from service.chat.service.sessions import SessionService
from service.platform.bridge import BRIDGE_MAX_REQUEST_BYTES, PLAN_ROUTE_PREFIX, PlanRead, PlanWrite


def register_plan_routes(app: FastAPI, sessions: SessionService) -> APIRouter:
    router = APIRouter()

    @router.post(PLAN_ROUTE_PREFIX + "{operation}")
    async def plan(request: Request, operation: str) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_400_BAD_REQUEST
                )
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            data = json.loads(raw)
            if operation == "get":
                PlanRead.model_validate(data)
                result = live.plans.current()
            elif operation == "write":
                command = PlanWrite.model_validate(data)
                result = (await live.write_plan(command)).payload
            else:
                raise ValueError("plan_operation_invalid")
        except PermissionError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_403_FORBIDDEN)
        except PlanConflict as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_409_CONFLICT)
        except ValueError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        return JSONResponse({"ok": True, "turn_id": turn_id, **result})

    app.include_router(router)
    return router
