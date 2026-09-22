"""Explicit artifact publication for the session-bound product CLI."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
)

from service.chat.api.bridge import scoped_bridge_caller
from service.platform.bridge import (
    ARTIFACT_PUBLISH_ROUTE,
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_SESSION_HEADER,
    ArtifactPublish,
    ArtifactPublisher,
    ArtifactPublishFailure,
)


def register_artifact_routes(
    app: FastAPI,
    resolve_caller: Callable[[str], ArtifactPublisher | None],
) -> APIRouter:
    router = APIRouter()

    @router.post(ARTIFACT_PUBLISH_ROUTE)
    async def publish_artifact(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
        turn_id = caller.publication_turn_id
        if not turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"},
                    HTTP_413_CONTENT_TOO_LARGE,
                )
        try:
            command = ArtifactPublish.model_validate(json.loads(raw))
        except (ValueError, ValidationError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        if resolve_caller(scope_id) is not caller or caller.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            artifact = await caller.publish_artifact(command.path, command.role, turn_id=turn_id)
        except ArtifactPublishFailure as error:
            return JSONResponse({"ok": False, "error": error.code}, HTTP_400_BAD_REQUEST)
        return JSONResponse({"ok": True, "artifact": artifact})

    app.include_router(router)
    return router
