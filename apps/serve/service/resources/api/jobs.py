"""HTTP surface for persistent local resource-import jobs."""

from __future__ import annotations

from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.status import HTTP_404_NOT_FOUND, HTTP_409_CONFLICT

from service.chat.service.events import SSE_HEARTBEAT_FRAME, sse_encode
from service.content.domain.model import ContentError
from service.identity.utils import request_owner_id
from service.platform.content import ImportMode, RootKind
from service.resources.service.jobs import (
    ResourceImportError,
    ResourceImportService,
    public_import_job,
)

RESOURCE_IMPORT_JOBS_PREFIX = "/api/resource/import-jobs"
SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
MAX_IMPORT_SOURCES = 256


class ImportJobCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project: str = Field(min_length=1)
    mode: ImportMode
    sources: tuple[str, ...] = Field(min_length=1, max_length=MAX_IMPORT_SOURCES)
    target_dir: str = ""


def _service(request: Request) -> ResourceImportService:
    service = getattr(request.app.state, "resource_imports", None)
    if not isinstance(service, ResourceImportService):
        raise HTTPException(503, "resource_import_service_unavailable")
    return service


def _error(error: ResourceImportError) -> HTTPException:
    status = (
        HTTP_404_NOT_FOUND if error.code == "resource_import_job_not_found" else HTTP_409_CONFLICT
    )
    return HTTPException(status, error.code)


def register_resource_import_routes(app: FastAPI) -> None:
    @app.post(RESOURCE_IMPORT_JOBS_PREFIX, status_code=202)
    async def create_import_job(
        command: ImportJobCreate,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        try:
            content = request.app.state.content
            target_dir = content.within_root(
                command.project, RootKind.RESOURCES, command.target_dir
            )
            job = _service(request).create(
                owner_id=request_owner_id(request),
                project_id=command.project,
                mode=command.mode,
                target_dir=target_dir,
                sources=command.sources,
                idempotency_key=idempotency_key or uuid4().hex,
            )
        except ContentError as error:
            raise HTTPException(400, error.code) from error
        except ResourceImportError as error:
            raise _error(error) from error
        return {"job": public_import_job(job)}

    @app.get(RESOURCE_IMPORT_JOBS_PREFIX)
    async def list_import_jobs(request: Request) -> dict:
        jobs = _service(request).list(owner_id=request_owner_id(request))
        return {"items": [public_import_job(job) for job in jobs]}

    @app.get(RESOURCE_IMPORT_JOBS_PREFIX + "/{job_id}")
    async def get_import_job(job_id: str, request: Request) -> dict:
        try:
            job = _service(request).get(job_id, owner_id=request_owner_id(request))
        except ResourceImportError as error:
            raise _error(error) from error
        return {"job": public_import_job(job)}

    @app.get(RESOURCE_IMPORT_JOBS_PREFIX + "/{job_id}/events")
    async def import_job_events(
        job_id: str,
        request: Request,
        after_seq: int = Query(default=0, ge=0),
    ) -> StreamingResponse:
        service = _service(request)
        owner_id = request_owner_id(request)
        try:
            service.get(job_id, owner_id=owner_id)
        except ResourceImportError as error:
            raise _error(error) from error

        async def body():
            async for event in service.events(job_id, owner_id=owner_id, after_seq=after_seq):
                yield SSE_HEARTBEAT_FRAME if event is None else sse_encode(event)

        return StreamingResponse(body(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)

    @app.post(RESOURCE_IMPORT_JOBS_PREFIX + "/{job_id}/cancel")
    async def cancel_import_job(job_id: str, request: Request) -> dict:
        try:
            job = _service(request).cancel(job_id, owner_id=request_owner_id(request))
        except ResourceImportError as error:
            raise _error(error) from error
        return {"job": public_import_job(job)}

    @app.post(RESOURCE_IMPORT_JOBS_PREFIX + "/{job_id}/retry")
    async def retry_import_job(job_id: str, request: Request) -> dict:
        try:
            job = _service(request).retry(job_id, owner_id=request_owner_id(request))
        except ResourceImportError as error:
            raise _error(error) from error
        return {"job": public_import_job(job)}


__all__ = ["RESOURCE_IMPORT_JOBS_PREFIX", "register_resource_import_routes"]
