"""Ownership-scoped reminder snapshots and explicit read acknowledgements."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt

from service.chat.persistence.attention import ATTENTION_ID_LIMIT
from service.chat.persistence.catalog import SessionPrincipal
from service.chat.service.attention import AttentionService
from service.identity.utils import request_owner_id

HTTP_CONFLICT = 409


class AttentionReadAll(BaseModel):
    epoch: str = Field(min_length=1)
    through_revision: StrictInt = Field(ge=0)


class AttentionRead(AttentionReadAll):
    ids: list[str] = Field(max_length=ATTENTION_ID_LIMIT)


def mount_attention_routes(app: FastAPI, attention: AttentionService) -> None:
    @app.get("/api/serve/attention")
    def snapshot(request: Request) -> dict[str, Any]:
        return attention.store.snapshot(SessionPrincipal(request_owner_id(request)))

    def acknowledge(request: Request, body: AttentionReadAll, ids: tuple[str, ...] | None) -> Any:
        try:
            return attention.store.read(
                SessionPrincipal(request_owner_id(request)),
                epoch=body.epoch,
                through_revision=body.through_revision,
                ids=ids,
            )
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=HTTP_CONFLICT)

    @app.post("/api/serve/attention/read")
    def read(request: Request, body: AttentionRead) -> Any:
        return acknowledge(request, body, tuple(body.ids))

    @app.post("/api/serve/attention/read-all")
    def read_all(request: Request, body: AttentionReadAll) -> Any:
        return acknowledge(request, body, None)

    @app.get("/api/serve/attention/{identity}/navigation")
    def navigation(identity: str, request: Request) -> JSONResponse:
        payload, status = attention.navigation(
            identity, SessionPrincipal(request_owner_id(request))
        )
        return JSONResponse(payload, status_code=status)
