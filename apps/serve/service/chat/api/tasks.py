"""Authenticated activation of current-turn product task identity."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import activate_task, task_failure_action
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    TASK_ACTIVATE_ROUTE,
    TaskActivate,
)
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES


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


def register_task_routes(
    app: FastAPI, sessions: SessionService, *, activities: Activities
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(TASK_ACTIVATE_ROUTE)
    async def activate(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return _failure(
                "bridge_access_denied", "run inside the active ScholarSeed turn", HTTP_403_FORBIDDEN
            )
        activity = live.turn_activity
        turn_id = live.active_product_turn_id
        generation = live.product_turn_generation
        user_id = live.user_id
        task = live.current_task
        lease_revision = live.task_lease_revision
        raw = await request.body()
        if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
            return _failure("bridge_request_too_large", "send a smaller activation request")
        try:
            command = TaskActivate.model_validate(json.loads(raw))

            async def activate_current():
                if (
                    sessions.bridge_caller(live.id) is not live
                    or live.turn_activity is not activity
                    or live.active_product_turn_id != turn_id
                    or live.product_turn_generation != generation
                    or live.user_id != user_id
                    or live.current_task is not task
                    or live.task_lease_revision != lease_revision
                ):
                    raise ValueError("task_context_stale")
                return await activate_task(live, command, caller=sessions.bridge_caller)

            lease = await activities.finish(ActivityDomain.BRIDGE, activate_current)
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
