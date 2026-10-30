"""Owner-checked diagnostic consent, preview, and explicitly confirmed export."""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from damoatrace.recording.diagnostics import DIAGNOSTIC_MEDIA_TYPE
from service.chat.persistence.catalog import SessionAccessError, SessionPrincipal
from service.chat.service.diagnostics import DIAGNOSTIC_FILENAME, DiagnosticService
from service.chat.service.recording import PolicyConflict, RecordingMode
from service.identity.utils import request_owner_id
from service.platform.activity import ActivityDomain, MaintenanceActive


class PolicyChange(BaseModel):
    mode: RecordingMode
    expected_revision: int = Field(ge=0)


class ExportConfirmation(BaseModel):
    confirmation: dict
    token: str
    accepted: bool


def mount_diagnostic_routes(app: FastAPI, diagnostics: DiagnosticService) -> None:
    async def admit():
        try:
            lease = diagnostics.activities.enter(ActivityDomain.DIAGNOSTIC, root=True)
        except MaintenanceActive as error:
            raise HTTPException(503, "update_maintenance") from error
        with lease:
            yield

    admission = [Depends(admit)]

    async def execute(operation, *args, **kwargs):
        try:
            return await diagnostics.activities.to_thread(
                ActivityDomain.DIAGNOSTIC, operation, *args, **kwargs
            )
        except SessionAccessError as error:
            raise HTTPException(404, "session not found") from error
        except PolicyConflict as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except OSError as error:
            raise HTTPException(503, "diagnostic storage unavailable") from error

    @app.get("/api/serve/sessions/{session_id}/diagnostic-policy", dependencies=admission)
    async def get_policy(session_id: str, request: Request):
        policy = await execute(
            diagnostics.recording.require,
            session_id,
            SessionPrincipal(user_id=request_owner_id(request)),
        )
        return policy.payload()

    @app.put("/api/serve/sessions/{session_id}/diagnostic-policy", dependencies=admission)
    async def put_policy(session_id: str, request: Request, body: PolicyChange):
        policy = await execute(
            diagnostics.recording.update,
            session_id,
            SessionPrincipal(user_id=request_owner_id(request)),
            mode=body.mode,
            expected_revision=body.expected_revision,
        )
        return policy.payload()

    @app.get("/api/serve/sessions/{session_id}/diagnostics/preview", dependencies=admission)
    async def preview(session_id: str, request: Request):
        return await execute(
            diagnostics.preview, session_id, SessionPrincipal(user_id=request_owner_id(request))
        )

    @app.post("/api/serve/sessions/{session_id}/diagnostics", dependencies=admission)
    async def export(session_id: str, request: Request, body: ExportConfirmation):
        bundle = await execute(
            diagnostics.export,
            session_id,
            SessionPrincipal(user_id=request_owner_id(request)),
            confirmation=body.confirmation,
            token=body.token,
            accepted=body.accepted,
        )
        return Response(
            bundle,
            media_type=DIAGNOSTIC_MEDIA_TYPE,
            headers={
                "Content-Disposition": f'attachment; filename="{DIAGNOSTIC_FILENAME}"',
                "Cache-Control": "no-store",
            },
        )

    @app.delete("/api/serve/sessions/{session_id}/diagnostics/content", dependencies=admission)
    async def clear(session_id: str, request: Request):
        count = await execute(
            diagnostics.clear, session_id, SessionPrincipal(user_id=request_owner_id(request))
        )
        return {"cleared_records": count}
