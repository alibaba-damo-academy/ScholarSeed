"""Active-turn Bridge access to the current project's resource inventory."""

from __future__ import annotations

import asyncio
import base64
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
    RESOURCE_READ_ENCODING_TEXT,
    RESOURCE_ROUTE_PREFIX,
    RESOURCE_SCOPE,
    RESOURCE_UNAVAILABLE_WARNING,
    ResourceList,
    ResourceListEntry,
    ResourceListResult,
    ResourceListWarning,
    ResourceRead,
    ResourceReadResult,
)
from service.platform.content import ContentPort

RESOURCE_LISTED_EVENT = "resource.listed"
RESOURCE_LIST_EVENT_KEY_PREFIX = "resource-list"
RESOURCE_READ_EVENT = "resource.read"
RESOURCE_READ_EVENT_KEY_PREFIX = "resource-read"
RESOURCE_PROJECT_REQUIRED = "resource_project_required"
RESOURCE_OFFSET_OUT_OF_RANGE = "resource_offset_out_of_range"
RESOURCE_CHANGED_DURING_READ = "resource_changed_during_read"


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


def _read_resource(
    content: ContentPort,
    project_id: str,
    query: ResourceRead,
) -> ResourceReadResult:
    normalized_path = query.path.replace("\\", "/").strip("/")
    for root in content.external_roots(project_id):
        if not root.available and (
            normalized_path == root.mount_path or normalized_path.startswith(f"{root.mount_path}/")
        ):
            raise ContentError(RESOURCE_UNAVAILABLE_WARNING)
    snapshot = content.snapshot(project_id, query.path)
    if query.offset > snapshot.size:
        raise ContentError(RESOURCE_OFFSET_OUT_OF_RANGE)
    if query.offset == snapshot.size:
        payload = b""
    else:
        end = min(snapshot.size, query.offset + query.limit) - 1
        payload = content.read_range(project_id, query.path, query.offset, end)
    current = content.snapshot(project_id, query.path)
    if current.revision != snapshot.revision:
        raise ContentError(RESOURCE_CHANGED_DURING_READ)
    if query.encoding == RESOURCE_READ_ENCODING_TEXT:
        try:
            value = payload.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ContentError("not_text_file") from error
    else:
        value = base64.b64encode(payload).decode("ascii")
    return ResourceReadResult(
        path=query.path,
        offset=query.offset,
        size=snapshot.size,
        media_type=snapshot.media_type,
        revision=snapshot.revision,
        encoding=query.encoding,
        content=value,
        eof=query.offset + len(payload) >= snapshot.size,
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
            query = ResourceList.model_validate(json.loads(raw))
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

    @router.post(RESOURCE_ROUTE_PREFIX + "read")
    async def read_resource(request: Request) -> JSONResponse:
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
            query = ResourceRead.model_validate(json.loads(raw))
        except OverflowError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_413_CONTENT_TOO_LARGE)
        except (ValueError, ValidationError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        if not _active_scope(sessions, live, project_id, turn_id):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            result = await asyncio.to_thread(_read_resource, content, project_id, query)
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
            RESOURCE_READ_EVENT,
            {"path": result.path, "offset": result.offset, "size": result.size},
            turn_id=turn_id,
            idempotency_key=f"{RESOURCE_READ_EVENT_KEY_PREFIX}:{uuid.uuid4().hex}",
        )
        return response

    app.include_router(router)
    return router


__all__ = ["register_resource_bridge"]
