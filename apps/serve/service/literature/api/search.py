"""HTTP surface for persistent literature agentic searches."""

from __future__ import annotations

import asyncio
from contextlib import aclosing

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.status import (
    HTTP_401_UNAUTHORIZED,
    HTTP_404_NOT_FOUND,
    HTTP_422_UNPROCESSABLE_CONTENT,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from service.chat.service.events import SSE_HEARTBEAT_FRAME, sse_encode
from service.identity.utils import request_owner_id, request_user_id
from service.invocation.service.runtime import (
    INVOCATION_WORKSPACE_UNAVAILABLE,
    InvocationError,
)
from service.invocation.service.skills import InvocationSkillError, InvocationSkillRuntimeError
from service.literature.persistence.search import LiteratureSearchError, LiteratureSearchService
from service.literature.service.status import ResultStatusRequest, ResultStatusService
from service.platform.passive_events import passive_events

LITERATURE_SEARCH_ROUTE_PREFIX = "/api/literature/searches"
LITERATURE_SEARCH_STATUS_ROUTE = LITERATURE_SEARCH_ROUTE_PREFIX + "/result-status"
SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
SEARCH_QUERY_MAX_CHARS = 20_000
SEARCH_LOGIN_REQUIRED = "login_required"


class LiteratureSearchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    query: str = Field(min_length=1, max_length=SEARCH_QUERY_MAX_CHARS)


def _service(request: Request) -> LiteratureSearchService:
    service = getattr(request.app.state, "literature_searches", None)
    if not isinstance(service, LiteratureSearchService):
        raise HTTPException(503, "literature_search_service_unavailable")
    return service


def register_literature_search_routes(app: FastAPI) -> None:
    statuses = ResultStatusService()

    @app.post(LITERATURE_SEARCH_STATUS_ROUTE)
    async def search_result_status(command: ResultStatusRequest) -> dict:
        result = await asyncio.to_thread(statuses.resolve, command.papers, command.project_id)
        return {"items": result}

    @app.post(LITERATURE_SEARCH_ROUTE_PREFIX, status_code=202)
    async def create_search(command: LiteratureSearchCreate, request: Request) -> dict:
        if not getattr(request.state, "user_id", ""):
            raise HTTPException(HTTP_401_UNAUTHORIZED, SEARCH_LOGIN_REQUIRED)
        try:
            task = await _service(request).create(
                command.query,
                owner_id=request_owner_id(request),
                user_id=request_user_id(request),
            )
        except LiteratureSearchError as error:
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, error.code) from error
        except InvocationSkillError as error:
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, error.code) from error
        except InvocationSkillRuntimeError as error:
            raise HTTPException(HTTP_503_SERVICE_UNAVAILABLE, error.code) from error
        except InvocationError as error:
            status = (
                HTTP_503_SERVICE_UNAVAILABLE
                if error.code == INVOCATION_WORKSPACE_UNAVAILABLE
                else HTTP_422_UNPROCESSABLE_CONTENT
            )
            raise HTTPException(status, error.code) from error
        except Exception as error:
            raise HTTPException(
                HTTP_503_SERVICE_UNAVAILABLE, "invocation_runtime_unavailable"
            ) from error
        return {"task": task}

    @app.get(LITERATURE_SEARCH_ROUTE_PREFIX)
    async def list_searches(request: Request) -> dict:
        return {"items": _service(request).list(owner_id=request_owner_id(request))}

    @app.get(LITERATURE_SEARCH_ROUTE_PREFIX + "/{task_id}/events")
    async def search_events(
        task_id: str,
        request: Request,
        after_seq: int = Query(default=0, ge=0),
    ) -> StreamingResponse:
        try:
            service = _service(request)
            owner_id = request_owner_id(request)
            service.get(task_id, owner_id=owner_id)
        except LiteratureSearchError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, error.code) from error

        async def body():
            async with aclosing(
                service.events(task_id, owner_id=owner_id, after_seq=after_seq)
            ) as source:
                async for event in source:
                    yield SSE_HEARTBEAT_FRAME if event is None else sse_encode(event)

        return StreamingResponse(
            passive_events(body(), request.app.state.activities),
            media_type=SSE_MEDIA_TYPE,
            headers=SSE_HEADERS,
        )

    @app.delete(LITERATURE_SEARCH_ROUTE_PREFIX + "/{task_id}", status_code=204)
    async def delete_search(task_id: str, request: Request) -> Response:
        try:
            await _service(request).delete(task_id, owner_id=request_owner_id(request))
        except LiteratureSearchError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, error.code) from error
        return Response(status_code=204)


__all__ = ["LITERATURE_SEARCH_ROUTE_PREFIX", "register_literature_search_routes"]
