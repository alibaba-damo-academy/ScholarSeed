"""Authenticated activation of current-turn product task identity."""

from __future__ import annotations

import json

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.chat.api.bridge import bridge_caller
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import activate_task, task_failure_action
from service.platform.bridge import BRIDGE_MAX_REQUEST_BYTES, TASK_ACTIVATE_ROUTE, TaskActivate


def _failure(reason: str, action: str, status: int = HTTP_400_BAD_REQUEST) -> JSONResponse:
    return JSONResponse(
        {
            "ok": False,
            "error": "task_activation_failed",
            "reason": reason,
            "recoverable": reason not in {"bridge_access_denied", "task_context_stale"},
            "action": action,
        },
        status,
    )


def register_task_routes(app: FastAPI, sessions: SessionService) -> APIRouter:
    router = APIRouter()

    @router.post(TASK_ACTIVATE_ROUTE)
    async def activate(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return _failure(
                "bridge_access_denied", "run inside the active ScholarSeed turn", HTTP_403_FORBIDDEN
            )
        raw = await request.body()
        if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
            return _failure("bridge_request_too_large", "send a smaller activation request")
        try:
            command = TaskActivate.model_validate(json.loads(raw))
            lease = await activate_task(live, command)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            reason = (
                str(error)
                if isinstance(error, ValueError) and str(error)
                else "task_binding_invalid"
            )
            return _failure(reason, task_failure_action(reason))
        return JSONResponse(
            {
                "ok": True,
                "task_type": lease.task_type.value,
                "workspace": lease.workspace,
                "run_id": lease.run_id,
            }
        )

    app.include_router(router)
    return router
