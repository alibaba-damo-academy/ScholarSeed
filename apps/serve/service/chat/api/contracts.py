"""Authenticated, read-only discovery of one product operation contract."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import HTTP_200_OK, HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.chat.api.bridge import scoped_bridge_admission, scoped_bridge_caller
from service.chat.service.contracts import describe_contract, list_contracts
from service.platform.activity import Activities
from service.platform.bridge import (
    CONTRACT_DESCRIBE_ROUTE,
    CONTRACT_LIST_ROUTE,
    ContractCaller,
    ContractDescribe,
)
from service.platform.queries import ContractList
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES


def register_contract_routes(
    app: FastAPI, resolve_caller: Callable[[str], ContractCaller | None], *, activities: Activities
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(scoped_bridge_admission(resolve_caller, activities))])

    @router.post(CONTRACT_DESCRIBE_ROUTE)
    @router.post(CONTRACT_LIST_ROUTE)
    async def describe(request: Request) -> JSONResponse:
        live = scoped_bridge_caller(request, resolve_caller)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        activity = live.bridge_activity
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_400_BAD_REQUEST
                )
        if (
            resolve_caller(live.id) is not live
            or live.publication_turn_id != turn_id
            or live.bridge_activity is not activity
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            command_type = (
                ContractList if request.url.path == CONTRACT_LIST_ROUTE else ContractDescribe
            )
            command = command_type.model_validate(json.loads(raw))
        except (ValidationError, ValueError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        project_id = getattr(live, "project_id", None)
        result = (
            list_contracts(command, project_id=project_id)
            if isinstance(command, ContractList)
            else describe_contract(
                command.target_capability, command.target_operation, project_id=project_id
            )
        )
        return JSONResponse(
            result, status_code=HTTP_200_OK if result["ok"] else HTTP_400_BAD_REQUEST
        )

    app.include_router(router)
    return router
