"""Resource search fast-path HTTP admission and disconnect cancellation."""

from __future__ import annotations

import asyncio
from contextlib import aclosing

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from service.chat.service.events import sse_encode
from service.identity.utils import request_owner_id, request_user_id
from service.invocation.api.routes import SSE_HEADERS, SSE_MEDIA_TYPE
from service.invocation.service.runtime import InvocationError
from service.invocation.service.skills import InvocationSkillError, InvocationSkillRuntimeError
from service.resources.api.web import WEB_SEARCH_QUERY_LIMIT
from service.resources.service.fallback import ResourceSearchFallback
from service.resources.service.search import OFFICIAL_RESULT_LIMIT, ResourceSearchService

RESOURCE_SEARCH_ROUTE = "/api/resource/web-search"
RESOURCE_SEARCH_UNAVAILABLE = "resource_search_unavailable"
SERVICE_UNAVAILABLE_STATUS = 503
REQUEST_INVALID_STATUS = 422
FALLBACK_SEARCH_ROUTE = RESOURCE_SEARCH_ROUTE + "/fallback"
RESOURCE_SEARCH_HEARTBEAT_FRAME = ": heartbeat\n\n"


class ResourceSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=WEB_SEARCH_QUERY_LIMIT)
    limit: int = Field(default=OFFICIAL_RESULT_LIMIT, ge=1, le=OFFICIAL_RESULT_LIMIT)

    @field_validator("query")
    @classmethod
    def normalized_query(cls, value: str) -> str:
        query = value.strip()
        if not query:
            raise ValueError("search_query_required")
        return query


class ResourceFallbackRequest(ResourceSearchRequest):
    native_available: StrictBool = True


def register_resource_search_routes(app: FastAPI) -> None:
    @app.post(FALLBACK_SEARCH_ROUTE)
    async def fallback(command: ResourceFallbackRequest, request: Request) -> StreamingResponse:
        service = getattr(request.app.state, "resource_search_fallback", None)
        if not isinstance(service, ResourceSearchFallback):
            raise HTTPException(SERVICE_UNAVAILABLE_STATUS, RESOURCE_SEARCH_UNAVAILABLE)
        if SSE_MEDIA_TYPE not in request.headers.get("accept", ""):
            raise HTTPException(REQUEST_INVALID_STATUS, "text_event_stream_required")
        try:
            prepared = await service.prepare(
                command.query,
                command.limit,
                command.native_available,
                owner_id=request_owner_id(request),
                user_id=request_user_id(request),
            )
        except (InvocationSkillError, InvocationError) as error:
            raise HTTPException(REQUEST_INVALID_STATUS, error.code) from error
        except InvocationSkillRuntimeError as error:
            raise HTTPException(SERVICE_UNAVAILABLE_STATUS, error.code) from error

        async def body():
            async with aclosing(service.stream(prepared)) as events:
                async for event in events:
                    yield RESOURCE_SEARCH_HEARTBEAT_FRAME if event is None else sse_encode(event)

        return StreamingResponse(body(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)

    @app.post(RESOURCE_SEARCH_ROUTE)
    async def search(command: ResourceSearchRequest, request: Request) -> dict:
        service = getattr(request.app.state, "resource_search", None)
        if not isinstance(service, ResourceSearchService):
            raise HTTPException(SERVICE_UNAVAILABLE_STATUS, RESOURCE_SEARCH_UNAVAILABLE)
        user_id = request_user_id(request)
        route_task = asyncio.current_task()

        async def watch_disconnect() -> None:
            while True:
                message = await request.receive()
                if message["type"] == "http.disconnect":
                    if route_task is not None:
                        route_task.cancel()
                    return

        watcher = asyncio.create_task(watch_disconnect())
        try:
            return await service.search(command.query, command.limit, user_id)
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
