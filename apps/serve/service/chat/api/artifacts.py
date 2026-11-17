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
    HTTP_503_SERVICE_UNAVAILABLE,
)

from service.chat.api.bridge import scoped_bridge_admission, scoped_bridge_caller
from service.chat.runtime.projection import (
    ARTIFACT_PUBLISH_ACCESS_DENIED,
    ARTIFACT_PUBLISH_IO_FAILED,
)
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    ARTIFACT_BATCH_COMPLETED,
    ARTIFACT_BATCH_FAILED,
    ARTIFACT_BATCH_PARTIAL,
    ARTIFACT_BATCH_ROUTE,
    ARTIFACT_PUBLISH_ROUTE,
    ArtifactPublish,
    ArtifactPublisher,
    ArtifactPublishFailure,
    ArtifactsPublish,
)
from service.platform.content import ArtifactSnapshotFailure
from service.platform.vocabulary import (
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
        raw = await request.body()
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

    @router.post(ARTIFACT_BATCH_ROUTE)
    async def publish_artifacts(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None or not caller.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
        activity = caller.bridge_activity
        turn_id = caller.publication_turn_id
        try:
            command = ArtifactsPublish.model_validate(json.loads(await request.body()))
        except (ValueError, ValidationError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )

        def current_scope() -> bool:
            return (
                scoped_bridge_caller(request, resolve_caller) is caller
                and resolve_caller(scope_id) is caller
                and caller.publication_turn_id == turn_id
                and caller.bridge_activity is activity
            )

        if not current_scope():
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        items: list[dict] = []
        retry_files: list[dict] = []
        for index, file in enumerate(command.files):
            item = {"index": index, "path": file.path, "role": file.role}
            try:
                if not current_scope():
                    raise ArtifactPublishFailure("bridge_access_denied")
                artifact = await activities.finish(
                    ActivityDomain.BRIDGE,
                    lambda: caller.publish_artifact(file.path, file.role, turn_id=turn_id),
                )
                item.update(status=ARTIFACT_BATCH_COMPLETED)
                item.update(
                    {
                        key: artifact[key]
                        for key in ("publication_id", "artifact_id", "sha256")
                        if key in artifact
                    }
                )
            except ArtifactPublishFailure as error:
                item.update(status=ARTIFACT_BATCH_FAILED, error=error.code)
                if error.code in ARTIFACT_FAILURE_MESSAGES:
                    item["message"] = ARTIFACT_FAILURE_MESSAGES[error.code]
                retry_files.append(file.model_dump())
            items.append(item)
        status = (
            ARTIFACT_BATCH_COMPLETED
            if not retry_files
            else ARTIFACT_BATCH_FAILED if len(retry_files) == len(items) else ARTIFACT_BATCH_PARTIAL
        )
        return JSONResponse(
            {
                "ok": status == ARTIFACT_BATCH_COMPLETED,
                "status": status,
                "items": items,
                "retry_files": retry_files,
            }
        )

    app.include_router(router)
    return router
