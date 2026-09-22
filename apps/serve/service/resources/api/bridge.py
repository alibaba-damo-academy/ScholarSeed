"""Active-turn Bridge access to the current project's resource inventory."""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
)

from service.chat.api.bridge import bridge_caller
from service.chat.runtime.live import LiveSession
from service.chat.service.sessions import SessionService
from service.content.domain.model import ContentError
from service.platform.bridge import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
    RESOURCE_REQUESTS,
    RESOURCE_ROUTE_PREFIX,
    RESOURCE_SCOPE,
    RESOURCE_UNAVAILABLE_WARNING,
    ResourceList,
    ResourceListEntry,
    ResourceListResult,
    ResourceListWarning,
)
from service.platform.content import ContentPort

RESOURCE_LISTED_EVENT = "resource.listed"
RESOURCE_LIST_EVENT_KEY_PREFIX = "resource-list"
RESOURCE_PROJECT_REQUIRED = "resource_project_required"


async def _request_body(request: Request) -> bytes:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
            raise OverflowError("bridge_request_too_large")
    return bytes(raw)


def _active_scope(
    sessions: SessionService,
    live: LiveSession,
    project_id: str,
    turn_id: str,
) -> bool:
    return (
        bool(turn_id)
        and sessions.bridge_caller(live.id) is live
        and live.project_id == project_id
        and live.ledger.active_turn_id == turn_id
    )


def _list_resources(
    content: ContentPort,
    project_id: str,
    query: ResourceList,
) -> ResourceListResult:
    page = content.enumerate_resources(project_id, query.cursor or None, query.limit)
    warnings = [
        ResourceListWarning(code=RESOURCE_UNAVAILABLE_WARNING, path=root.mount_path)
        for root in sorted(content.external_roots(project_id), key=lambda item: item.mount_path)
        if not root.available
    ]
    return ResourceListResult(
        scope=RESOURCE_SCOPE,
        entries=[ResourceListEntry(path=entry.path, size=entry.size) for entry in page.entries],
        next_cursor=page.next_cursor,
        warnings=warnings,
    )


def register_resource_bridge(
    app: FastAPI,
    sessions: SessionService,
    content: ContentPort,
) -> APIRouter:
    router = APIRouter()

    @router.post(RESOURCE_ROUTE_PREFIX + "list")
    async def list_resources(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.ledger.active_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        project_id = live.project_id
        turn_id = live.ledger.active_turn_id
        if not project_id:
            return JSONResponse(
                {"ok": False, "error": RESOURCE_PROJECT_REQUIRED}, HTTP_400_BAD_REQUEST
            )
        try:
            raw = await _request_body(request)
            query = RESOURCE_REQUESTS["list"].model_validate(json.loads(raw))
        except OverflowError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_413_CONTENT_TOO_LARGE)
        except (ValueError, ValidationError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        if not _active_scope(sessions, live, project_id, turn_id):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            result = await asyncio.to_thread(_list_resources, content, project_id, query)
        except (ContentError, OSError) as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        if not _active_scope(sessions, live, project_id, turn_id):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        payload = result.model_dump(mode="json")
        response = JSONResponse(payload)
        if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
            return JSONResponse(
                {"ok": False, "error": "bridge_response_too_large; reduce limit"},
                HTTP_400_BAD_REQUEST,
            )
        await live.publish(
            RESOURCE_LISTED_EVENT,
            {
                "returned": len(result.entries),
                "has_more": result.next_cursor is not None,
                "warning_codes": [warning.code for warning in result.warnings],
            },
            turn_id=turn_id,
            idempotency_key=f"{RESOURCE_LIST_EVENT_KEY_PREFIX}:{uuid.uuid4().hex}",
        )
        return response

    app.include_router(router)
    return router


__all__ = ["register_resource_bridge"]
