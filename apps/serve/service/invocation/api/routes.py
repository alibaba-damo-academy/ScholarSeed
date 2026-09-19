"""HTTP and SSE surface for isolated single-turn invocations."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from tempfile import SpooledTemporaryFile
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
    HTTP_422_UNPROCESSABLE_CONTENT,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from service.chat.service.events import SSE_HEARTBEAT_FRAME, sse_encode
from service.identity.utils import request_owner_id, request_user_id
from service.invocation.api.schema import InteractionResponseRequest, InvocationStartRequest
from service.invocation.service.artifacts import (
    ARTIFACT_FILE_NOT_FOUND,
    ARTIFACT_INTEGRITY_MISMATCH,
    ARTIFACT_PATH_INVALID,
    InvocationArtifactError,
)
from service.invocation.service.runtime import (
    INVOCATION_WORKSPACE_UNAVAILABLE,
    InvocationError,
    InvocationService,
)
from service.invocation.service.skills import InvocationSkillError, InvocationSkillRuntimeError

INVOCATION_ROUTE_PREFIX = "/api/agent/invocations"
SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
ARTIFACT_STREAM_CHUNK_BYTES = 1024 * 1024


def _artifact_stream(handle: SpooledTemporaryFile[bytes]) -> Iterator[bytes]:
    try:
        while chunk := handle.read(ARTIFACT_STREAM_CHUNK_BYTES):
            yield chunk
    finally:
        handle.close()


def _service(request: Request) -> InvocationService:
    service = getattr(request.app.state, "invocations", None)
    if not isinstance(service, InvocationService):
        raise HTTPException(HTTP_503_SERVICE_UNAVAILABLE, "invocation_service_unavailable")
    return service


def register_invocation_routes(app: FastAPI) -> None:
    @app.post(INVOCATION_ROUTE_PREFIX)
    async def start_invocation(
        command: InvocationStartRequest,
        request: Request,
    ) -> StreamingResponse:
        if SSE_MEDIA_TYPE not in request.headers.get("accept", ""):
            raise HTTPException(HTTP_400_BAD_REQUEST, "text_event_stream_required")
        try:
            prepared = await _service(request).prepare(
                command.command(),
                owner_id=request_owner_id(request),
                user_id=request_user_id(request),
            )
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

        async def body():
            async for event in _service(request).stream(prepared):
                yield SSE_HEARTBEAT_FRAME if event is None else sse_encode(event)

        return StreamingResponse(body(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)

    @app.post(INVOCATION_ROUTE_PREFIX + "/{invocation_id}/interrupt")
    async def interrupt_invocation(invocation_id: str, request: Request) -> JSONResponse:
        accepted = await _service(request).interrupt(
            invocation_id, owner_id=request_owner_id(request)
        )
        if not accepted:
            raise HTTPException(HTTP_404_NOT_FOUND, "invocation_not_running")
        return JSONResponse({"accepted": True})

    @app.post(INVOCATION_ROUTE_PREFIX + "/{invocation_id}/interactions/{interaction_id}")
    async def resolve_interaction(
        invocation_id: str,
        interaction_id: str,
        command: InteractionResponseRequest,
        request: Request,
    ) -> JSONResponse:
        accepted = await _service(request).respond(
            invocation_id,
            owner_id=request_owner_id(request),
            request_id=interaction_id,
            decision=command.decision,
            values=command.values,
        )
        if not accepted:
            raise HTTPException(HTTP_404_NOT_FOUND, "interaction_not_pending")
        return JSONResponse({"accepted": True})

    @app.get(INVOCATION_ROUTE_PREFIX + "/{invocation_id}/artifacts/{artifact_id}")
    async def read_artifact(
        invocation_id: str,
        artifact_id: str,
        request: Request,
    ) -> StreamingResponse:
        try:
            record, snapshot = await _service(request).artifact(
                invocation_id,
                artifact_id,
                owner_id=request_owner_id(request),
            )
        except InvocationArtifactError as error:
            if error.code == ARTIFACT_INTEGRITY_MISMATCH:
                raise HTTPException(HTTP_409_CONFLICT, error.code) from error
            if error.code in {ARTIFACT_FILE_NOT_FOUND, ARTIFACT_PATH_INVALID}:
                raise HTTPException(HTTP_404_NOT_FOUND, ARTIFACT_FILE_NOT_FOUND) from error
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, error.code) from error
        filename = quote(Path(record.relative_path).name)
        return StreamingResponse(
            _artifact_stream(snapshot),
            media_type=record.mime_type or None,
            headers={"Content-Disposition": f"attachment; filename*=utf-8''{filename}"},
        )


__all__ = ["INVOCATION_ROUTE_PREFIX", "register_invocation_routes"]
