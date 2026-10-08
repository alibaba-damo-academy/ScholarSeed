"""Bridge route that reports the turn's effective full-text scope (proposal 116 G1)."""

from __future__ import annotations

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
from service.literature.service.receipt import issue_receipt
from service.platform.bridge import LITERATURE_RECEIPT_ROUTE, LiteratureReceipt

logger = logging.getLogger(__name__)

RECEIPT_TASK_REQUIRED = "fulltext_authorization_task_required"


def register_receipt_routes(
    app: FastAPI,
    sessions: SessionService,
    authorizer: FulltextAuthorizer | None,
) -> APIRouter:
    router = APIRouter()

    @router.post(LITERATURE_RECEIPT_ROUTE)
    async def receipt(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        policy = task_authorization_policy(getattr(live, "active_task_type", ""))
        if policy is None:
            return JSONResponse(
                {
                    "ok": False,
                    "error": RECEIPT_TASK_REQUIRED,
                    "recoverable": True,
                    "action": TASK_ACTIVATION_REQUIRED_ACTION,
                },
                HTTP_400_BAD_REQUEST,
            )
        if authorizer is None:
            return JSONResponse(
                {"ok": False, "error": RECEIPT_TASK_REQUIRED, "recoverable": False},
                HTTP_400_BAD_REQUEST,
            )
        try:
            query = LiteratureReceipt.model_validate(json.loads(await request.body()))
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "receipt_request_invalid"}, HTTP_400_BAD_REQUEST
            )
        return JSONResponse(
            issue_receipt(
                authorizer,
                run=query.run,
                session_id=live.id,
                snapshot_id=live.active_assistant_snapshot_id,
                turn_id=live.ledger.active_turn_id,
                authorization_type=policy.authorization_type,
                client_turn_id=getattr(live, "active_product_turn_id", ""),
            ).payload()
        )

    app.include_router(router)
    return router


__all__ = ["RECEIPT_TASK_REQUIRED", "register_receipt_routes"]
