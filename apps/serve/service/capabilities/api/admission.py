"""Authorize a new standard Skill execution against current product state."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from service.chat.api.bridge import scoped_bridge_caller
from service.chat.runtime.composition import LiveSessionService
from service.platform.bridge import (
    BRIDGE_MAX_REQUEST_BYTES,
    SKILL_ADMISSION_ROUTE,
    SkillAdmission,
    SkillCaller,
)

SKILL_ACCESS_DENIED = "skill_access_denied"
SKILL_UNAVAILABLE = "skill_unavailable"
SKILL_ADMISSION_UNAVAILABLE = "skill_admission_unavailable"


def register_skill_admission(
    app: FastAPI,
    resolve_caller: Callable[[str], SkillCaller | None],
    runtime: LiveSessionService,
) -> APIRouter:
    router = APIRouter()

    @router.post(SKILL_ADMISSION_ROUTE)
    async def admit(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None:
            return JSONResponse({"ok": False, "error": SKILL_ACCESS_DENIED}, HTTP_403_FORBIDDEN)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"},
                    HTTP_413_CONTENT_TOO_LARGE,
                )
        try:
            command = SkillAdmission.model_validate(json.loads(body))
            script = Path(command.path)
            if not script.is_absolute() or not script.is_file():
                raise ValueError(SKILL_UNAVAILABLE)
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        try:
            skill = await runtime.skill_admission(
                path=script, cwd=caller.runtime_workdir, user_id=caller.user_id
            )
        except (RuntimeError, ValueError, OSError):
            return JSONResponse(
                {"ok": False, "error": SKILL_ADMISSION_UNAVAILABLE}, HTTP_503_SERVICE_UNAVAILABLE
            )
        if scoped_bridge_caller(request, resolve_caller) is not caller:
            return JSONResponse({"ok": False, "error": SKILL_ACCESS_DENIED}, HTTP_403_FORBIDDEN)
        if skill is None or not skill.get("active"):
            reason = (
                str(skill.get("unavailable_reason") or SKILL_UNAVAILABLE)
                if skill
                else SKILL_UNAVAILABLE
            )
            return JSONResponse({"ok": False, "error": reason}, HTTP_403_FORBIDDEN)
        return JSONResponse({"ok": True, "skill": skill["name"]})

    app.include_router(router)
    return router
