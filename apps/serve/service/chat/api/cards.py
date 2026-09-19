"""Session-bound bridge route for typed conversation cards."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
)

from service.chat.api.bridge import scoped_bridge_caller
from service.chat.service.cards import CardRegistry, DisplayCardError
from service.platform.bridge import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_SESSION_HEADER,
    DISPLAY_CARD_ROUTE,
    DisplayCard,
    DisplayCardPublisher,
)


def register_card_routes(
    app: FastAPI,
    resolve_caller: Callable[[str], DisplayCardPublisher | None],
    registry: CardRegistry | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post(DISPLAY_CARD_ROUTE)
    async def display_card(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
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
            command = DisplayCard.model_validate(json.loads(raw))
        except (ValueError, ValidationError):
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        if registry is not None and not registry.allows_direct(command.type):
            return JSONResponse(
                {"ok": False, "error": "display_card_requires_domain_publication"},
                HTTP_400_BAD_REQUEST,
            )
        if resolve_caller(scope_id) is not caller or caller.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            card = await caller.display_card(command.type, command.content, turn_id=turn_id)
        except DisplayCardError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        return JSONResponse({"ok": True, "card": card})

    app.include_router(router)
    return router
