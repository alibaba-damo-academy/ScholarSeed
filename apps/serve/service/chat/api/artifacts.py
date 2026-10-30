"""Explicit artifact publication for the session-bound product CLI."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from service.chat.api.bridge import scoped_bridge_admission, scoped_bridge_caller
from service.chat.runtime.projection import (
    ARTIFACT_PUBLISH_ACCESS_DENIED,
    ARTIFACT_PUBLISH_IO_FAILED,
)
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    ARTIFACT_PUBLISH_ROUTE,
    ArtifactPublish,
    ArtifactPublisher,
    ArtifactPublishFailure,
)
from service.platform.content import ArtifactSnapshotFailure
from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_SESSION_HEADER,
)

ARTIFACT_FAILURE_MESSAGES = {
    ArtifactSnapshotFailure.BUSY.value: "The file or snapshot storage is in use. Close applications holding the file and retry publication. Your source file has not been deleted.",
    ArtifactSnapshotFailure.ACCESS_DENIED.value: "Snapshot access was denied. Ask your administrator to restore access to the source file and project storage, then retry. Do not disable security protection.",
    ArtifactSnapshotFailure.UNSUPPORTED.value: "The storage does not support the filesystem operations required for immutable snapshots. Use a supported local project filesystem and retry publication.",
    ArtifactSnapshotFailure.DISK_FULL.value: "Snapshot storage is full. Free disk space and retry publication. Your source file has not been deleted.",
    ArtifactSnapshotFailure.UNAVAILABLE.value: "The snapshot could not be created. Check the application logs for the failing filesystem operation before retrying. The source file may still be available.",
}


def register_artifact_routes(
    app: FastAPI,
    resolve_caller: Callable[[str], ArtifactPublisher | None],
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(scoped_bridge_admission(resolve_caller, activities))])

    @router.post(ARTIFACT_PUBLISH_ROUTE)
    async def publish_artifact(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
        activity = caller.bridge_activity
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
        if (
            resolve_caller(scope_id) is not caller
            or caller.publication_turn_id != turn_id
            or caller.bridge_activity is not activity
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            artifact = await activities.finish(
                ActivityDomain.BRIDGE,
                lambda: caller.publish_artifact(command.path, command.role, turn_id=turn_id),
            )
        except ArtifactPublishFailure as error:
            status_by_code = {
                ARTIFACT_PUBLISH_ACCESS_DENIED: HTTP_403_FORBIDDEN,
                ARTIFACT_PUBLISH_IO_FAILED: HTTP_503_SERVICE_UNAVAILABLE,
            }
            return JSONResponse(
                {
                    "ok": False,
                    "error": error.code,
                    **(
                        {"message": ARTIFACT_FAILURE_MESSAGES[error.code]}
                        if error.code in ARTIFACT_FAILURE_MESSAGES
                        else {}
                    ),
                },
                status_by_code.get(error.code, HTTP_400_BAD_REQUEST),
            )
        return JSONResponse({"ok": True, "artifact": artifact})

    app.include_router(router)
    return router
