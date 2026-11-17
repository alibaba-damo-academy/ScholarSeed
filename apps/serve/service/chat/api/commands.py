"""Session-bound product commands held through execution and migration."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import BRIDGE_REQUESTS
from service.platform.vocabulary import (
    BRIDGE_MAX_RESPONSE_BYTES,
)

COMMAND_DENIED = "bridge_access_denied"
COMMAND_INVALID = "bridge_invalid_parameters"
COMMAND_RESPONSE_TOO_LARGE = "bridge_response_too_large"


@dataclass(frozen=True)
class SessionCommandContext:
    session_id: str
    project_id: str
    workdir: Path


@dataclass(frozen=True)
class SessionCommand:
    execute: Callable[[SessionCommandContext, BaseModel], BaseModel]
    errors: tuple[type[Exception], ...]
    compact: Callable[[BaseModel], BaseModel] | None = None
    recovery: Callable[[BaseModel, Exception], tuple[dict, str] | None] | None = None


def register_session_commands(
    app: FastAPI,
    sessions: SessionService,
    commands: Mapping[tuple[str, str], SessionCommand],
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    def endpoint(key: tuple[str, str], command: SessionCommand):
        async def invoke(request: Request) -> JSONResponse:
            live = bridge_caller(request, sessions)
            if live is None or not live.ledger.active_turn_id:
                return JSONResponse({"ok": False, "error": COMMAND_DENIED}, HTTP_403_FORBIDDEN)
            context = SessionCommandContext(live.id, live.project_id, live.runtime_workdir)
            turn_id, activity = live.ledger.active_turn_id, live.bridge_activity
            raw = await request.body()
            try:
                query = BRIDGE_REQUESTS[key].request_type.model_validate(json.loads(raw))
            except (ValueError, ValidationError):
                return JSONResponse({"ok": False, "error": COMMAND_INVALID}, HTTP_400_BAD_REQUEST)

            async def execute() -> BaseModel:
                return await activities.to_thread(
                    ActivityDomain.BRIDGE, command.execute, context, query
                )

            generation = getattr(live, "interrupt_generation", None)
            attachment = getattr(live, "attachment_generation", None)

            def current() -> bool:
                return (
                    sessions.bridge_caller(live.id) is live
                    and live.ledger.active_turn_id == turn_id
                    and live.bridge_activity is activity
                    and live.project_id == context.project_id
                    and live.runtime_workdir == context.workdir
                    and getattr(live, "interrupt_generation", None) == generation
                    and getattr(live, "attachment_generation", None) == attachment
                )

            while True:
                try:
                    async with live.activation_lock:
                        if not current():
                            return JSONResponse(
                                {"ok": False, "error": COMMAND_DENIED}, HTTP_403_FORBIDDEN
                            )
                        result = await activities.finish(ActivityDomain.BRIDGE, execute)
                    break
                except command.errors as error:
                    failure = {"ok": False, "error": getattr(error, "code", str(error))}
                    recovery = command.recovery(query, error) if command.recovery else None
                    if recovery is None:
                        return JSONResponse(failure, HTTP_400_BAD_REQUEST)
                if not current():
                    return JSONResponse({"ok": False, "error": COMMAND_DENIED}, HTTP_403_FORBIDDEN)
                question, retry_answer = recovery
                with activities.continue_from(live.turn_activity, ActivityDomain.BRIDGE) as lease:
                    decision = await live.interactions.request_product_input(
                        question,
                        turn_id=turn_id,
                        item_id=question["id"],
                        activity=lease,
                    )
                if not current():
                    return JSONResponse({"ok": False, "error": COMMAND_DENIED}, HTTP_403_FORBIDDEN)
                if decision.get("cancelled") or decision.get("answers") != {
                    question["id"]: retry_answer
                }:
                    return JSONResponse({**failure, "cancelled": True}, HTTP_400_BAD_REQUEST)
            response = JSONResponse(result.model_dump(mode="json"))
            if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
                if command.compact is None:
                    return JSONResponse(
                        {"ok": False, "error": COMMAND_RESPONSE_TOO_LARGE}, HTTP_400_BAD_REQUEST
                    )
                response = JSONResponse(command.compact(result).model_dump(mode="json"))
            return response

        return invoke

    for key, command in commands.items():
        router.add_api_route(BRIDGE_REQUESTS[key].route, endpoint(key, command), methods=["POST"])
    app.include_router(router)
    return router
