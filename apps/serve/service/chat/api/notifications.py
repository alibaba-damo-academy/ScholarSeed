"""Shared invalidations and bounded, read-only session summaries."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from service.chat.persistence.catalog import SessionPrincipal
from service.chat.service.sessions import SessionService
from service.identity.utils import request_owner_id
from service.platform.notifications import NOTIFICATION_PATH
from service.platform.passive_events import passive_events

STATUS_SESSION_LIMIT = 200
STATUS_QUEUE_LIMIT = 500
HTTP_UNPROCESSABLE_ENTITY = 422


class StatusRequest(BaseModel):
    session_ids: list[str] = Field(max_length=STATUS_SESSION_LIMIT)
    queued_ids: dict[str, list[str]] = Field(default_factory=dict)


def mount_notification_routes(app: FastAPI, sessions: SessionService) -> None:
    @app.post("/api/serve/status")
    def status(request: Request, body: StatusRequest) -> Any:
        if sum(map(len, body.queued_ids.values())) > STATUS_QUEUE_LIMIT:
            return JSONResponse(
                {"error": "too_many_queue_ids"}, status_code=HTTP_UNPROCESSABLE_ENTITY
            )
        return sessions.status(
            body.session_ids, SessionPrincipal(request_owner_id(request)), body.queued_ids
        )

    @app.get(NOTIFICATION_PATH)
    async def notifications(request: Request) -> StreamingResponse:
        return StreamingResponse(
            passive_events(
                app.state.notifications.events(request_owner_id(request)),
                app.state.activities,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
