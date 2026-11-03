"""Bridge route that reports the turn's effective full-text scope (proposal 116 G1)."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    FulltextAuthorizer,
    task_authorization_policy,
)
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import (
    TASK_ACTIVATION_REQUIRED_ACTION,
    fulltext_binding_workspace,
    verified_authorization_context,
)
from service.literature.service.receipt import issue_receipt
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import LITERATURE_RECEIPT_ROUTE, LiteratureReceipt
from service.platform.context import FulltextBindingScope

logger = logging.getLogger(__name__)

RECEIPT_TASK_REQUIRED = "fulltext_authorization_task_required"


def register_receipt_routes(
    app: FastAPI,
    sessions: SessionService,
    authorizer: FulltextAuthorizer | None,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(LITERATURE_RECEIPT_ROUTE)
    async def receipt(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
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
        snapshot_id = live.active_assistant_snapshot_id
        client_turn_id = getattr(live, "active_product_turn_id", "")
        try:
            query = LiteratureReceipt.model_validate(json.loads(await request.body()))
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "receipt_request_invalid"}, HTTP_400_BAD_REQUEST
            )
        try:
            task_context = verified_authorization_context(
                live, policy.task_type, workspace=query.run
            )
        except ValueError as error:
            return JSONResponse(
                {
                    "ok": False,
                    "error": RECEIPT_TASK_REQUIRED,
                    "reason": str(error),
                    "recoverable": True,
                    "action": TASK_ACTIVATION_REQUIRED_ACTION,
                },
                HTTP_400_BAD_REQUEST,
            )
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            binding_scope = FulltextBindingScope(
                live.id,
                getattr(live, "project_id", "") or "",
                fulltext_binding_workspace(live, policy.task_type),
            )
            result = await activities.to_thread(
                ActivityDomain.BRIDGE,
                issue_receipt,
                authorizer,
                run=query.run,
                session_id=live.id,
                snapshot_id=snapshot_id,
                turn_id=turn_id,
                authorization_type=policy.authorization_type,
                client_turn_id=client_turn_id,
                task_context=task_context,
                binding_scope=binding_scope,
            )
            if (
                sessions.bridge_caller(live.id) is not live
                or live.publication_turn_id != turn_id
                or live.active_assistant_snapshot_id != snapshot_id
                or fulltext_binding_workspace(live, policy.task_type) != binding_scope.workspace
                or verified_authorization_context(live, policy.task_type, workspace=query.run)
                != task_context
            ):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            return JSONResponse(result.payload())
        except (ValueError, OSError) as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)

    app.include_router(router)
    return router


__all__ = ["RECEIPT_TASK_REQUIRED", "register_receipt_routes"]
