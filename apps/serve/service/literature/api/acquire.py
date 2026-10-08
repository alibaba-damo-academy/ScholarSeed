"""Bridge route for authorized full-text acquisition (proposal 116 G1 PEP)."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    FulltextAuthorizer,
    task_authorization_policy,
)
from service.chat.api.bridge import bridge_caller
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import TASK_ACTIVATION_REQUIRED_ACTION
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts
from service.literature.service.fulltexts import PAPER_REF_PREFIX
from service.platform.bridge import (
    LITERATURE_ACQUIRE_ROUTE,
    LiteratureAcquire,
)

logger = logging.getLogger(__name__)

ACQUIRE_TASK_REQUIRED = "fulltext_authorization_task_required"
ACQUIRE_AUTHORIZATION_REQUIRED = "fulltext_authorization_required"


def register_acquire_routes(
    app: FastAPI,
    sessions: SessionService,
    authorizer: FulltextAuthorizer | None,
) -> APIRouter:
    router = APIRouter()

    @router.post(LITERATURE_ACQUIRE_ROUTE)
    async def acquire(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        policy = task_authorization_policy(getattr(live, "active_task_type", ""))
        if policy is None:
            return JSONResponse(
                {
                    "ok": False,
                    "error": ACQUIRE_TASK_REQUIRED,
                    "recoverable": True,
                    "action": TASK_ACTIVATION_REQUIRED_ACTION,
                },
                HTTP_400_BAD_REQUEST,
            )
        if authorizer is None:
            return JSONResponse(
                {"ok": False, "error": ACQUIRE_TASK_REQUIRED, "recoverable": False},
                HTTP_400_BAD_REQUEST,
            )
        try:
            query = LiteratureAcquire.model_validate(json.loads(await request.body()))
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "acquire_request_invalid"}, HTTP_400_BAD_REQUEST
            )
        snapshot_id = live.active_assistant_snapshot_id
        turn_id = live.ledger.active_turn_id
        # Authorization is decided for the whole batch before any byte leaves the
        # machine: a partial grant must not become an authorization oracle.
        for paper in query.papers:
            try:
                authorizer.require(
                    session_id=live.id,
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=policy.authorization_type,
                    ref_id=PAPER_REF_PREFIX + paper.paper_id,
                    client_turn_id=getattr(live, "active_product_turn_id", ""),
                )
            except ValueError as exc:
                return JSONResponse(
                    {"ok": False, "error": ACQUIRE_AUTHORIZATION_REQUIRED, "reason": str(exc)},
                    HTTP_400_BAD_REQUEST,
                )
        outcome = await asyncio.to_thread(
            acquire_fulltexts,
            tuple(
                AcquirePaper(
                    paper_id=paper.paper_id,
                    identifier=paper.identifier,
                    identifier_kind=paper.identifier_kind,
                    title=paper.title,
                )
                for paper in query.papers
            ),
        )
        return JSONResponse(outcome.payload())

    app.include_router(router)
    return router


__all__ = ["register_acquire_routes"]
