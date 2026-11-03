"""Host-only connector management and a state-bound browser OAuth callback."""

from __future__ import annotations

from typing import Literal
from urllib.parse import parse_qs

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from service.identity.utils import request_user_id, require_host_process
from service.settings.connectors.catalog import CONNECTORS
from service.settings.connectors.hosted import OWNER_KEY
from service.settings.connectors.service import ConnectorService, failure

CONNECTOR_ROUTE = "/api/settings/connectors"
CALLBACK_ROUTE = CONNECTOR_ROUTE + "/callback"
REQUEST_LIMIT = 16384
CUSTOM_REQUEST_LIMIT = 1024 * 1024
HTTP_INVALID = 422
HTTP_UNAVAILABLE = 503
HTTP_OVERSIZE = 413
CALLBACK_SUCCESS = "Authorization complete. Return to ScholarSeed. / 授权完成，请返回书深。"
CALLBACK_FAILURE = "Authorization was not completed. Return to ScholarSeed to retry. / 未完成授权，请返回书深重试。"
CALLBACK_STATE_KEY = "connector_callback"
CALLBACK_MAX_FIELDS = 16


class ConnectorCallbackPrivacy:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] == CALLBACK_ROUTE:
            raw = scope.get("query_string", b"")
            scope["query_string"] = b""
            values = {}
            if len(raw) <= REQUEST_LIMIT:
                try:
                    parsed = parse_qs(raw.decode("utf-8"), max_num_fields=CALLBACK_MAX_FIELDS)
                    values = {key: rows[0] for key, rows in parsed.items() if len(rows) == 1}
                except (ValueError, UnicodeError):
                    values = {}
            scope.setdefault("state", {})[CALLBACK_STATE_KEY] = values
        await self.app(scope, receive, send)


class ConnectorAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    operation: Literal[
        "install",
        "remove",
        "revoke",
        "cancel",
        "login",
        "key",
        "libraries",
        "toggle",
        "retry",
        "inspect",
        "custom_save",
        "custom_remove",
        "custom_toggle",
        "custom_retry",
    ]
    access_token: str = Field(default="", max_length=8192, repr=False)
    library_type: str = Field(default="", max_length=16)
    library_id: str = Field(default="", max_length=32)
    enabled: bool = True
    session_id: str = Field(default="", max_length=128)
    expected_revision: int | None = Field(default=None, ge=0)
    servers: list[dict] = Field(default_factory=list, max_length=128, repr=False)


def mount_connector_routes(app: FastAPI, service: ConnectorService) -> None:
    app.add_middleware(ConnectorCallbackPrivacy)

    @app.get(CONNECTOR_ROUTE, dependencies=[Depends(require_host_process)])
    async def catalog():
        try:
            return {"connectors": await service.catalog()}
        except (OSError, ValueError):
            raise HTTPException(HTTP_UNAVAILABLE, "connector_storage_unavailable") from None

    @app.post(CONNECTOR_ROUTE + "/{identifier}", dependencies=[Depends(require_host_process)])
    async def operate(identifier: str, request: Request):
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > CUSTOM_REQUEST_LIMIT:
                raise HTTPException(HTTP_OVERSIZE, "connector_request_too_large")
        try:
            action = ConnectorAction.model_validate_json(payload)
            port = request.scope["server"][1]
            redirect = f"http://127.0.0.1:{port}{CALLBACK_ROUTE}"
            values = action.model_dump()
            item = CONNECTORS.get(identifier)
            if action.operation == "login" and item and item.hosted_oauth:
                values[OWNER_KEY] = request_user_id(request)
            return await service.operate(
                identifier,
                action.operation,
                values=values,
                redirect=redirect,
            )
        except ValueError as error:
            raise HTTPException(HTTP_INVALID, failure(error)) from None
        except OSError:
            raise HTTPException(HTTP_UNAVAILABLE, "connector_storage_unavailable") from None

    @app.get(CALLBACK_ROUTE)
    async def callback(request: Request):
        values = getattr(request.state, CALLBACK_STATE_KEY, {})
        state = values.get("state", "")
        code = values.get("code", "")
        iss = values.get("iss", "")
        error = values.get("error", "")
        if (
            not state
            or len(state) > REQUEST_LIMIT
            or len(code) > REQUEST_LIMIT
            or len(iss) > REQUEST_LIMIT
        ):
            return PlainTextResponse(CALLBACK_FAILURE, status_code=HTTP_INVALID)
        try:
            result = await service.callback(state, code, iss, bool(error))
        except (ValueError, OSError):
            result = False
        return PlainTextResponse(
            CALLBACK_SUCCESS if result else CALLBACK_FAILURE,
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
