"""Session-bound bridge route for typed conversation cards."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_413_CONTENT_TOO_LARGE,
)

from service.capabilities.service.descriptor import ComponentValidationError
from service.chat.api.bridge import scoped_bridge_admission, scoped_bridge_caller
from service.chat.service.cards import CardRegistry, DisplayCardError
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    COMPONENT_CATALOG_OPERATION,
    COMPONENT_DISPLAY_OPERATION,
    COMPONENT_PREFLIGHT_OPERATION,
    COMPONENT_REQUEST_OPERATION,
    COMPONENT_ROUTE_PREFIX,
    DISPLAY_CARD_ROUTE,
    PLUGIN_INSTALL_ROUTE,
    ComponentCatalog,
    ComponentInvocation,
    ComponentPreflight,
    DisplayCard,
    DisplayCardPublisher,
    PluginInstallation,
)
from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_SESSION_HEADER,
)


def register_card_routes(
    app: FastAPI,
    resolve_caller: Callable[[str], DisplayCardPublisher | None],
    registry: CardRegistry | None = None,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(scoped_bridge_admission(resolve_caller, activities))])

    @router.post(PLUGIN_INSTALL_ROUTE)
    async def plugin_installation(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None or not caller.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
        turn_id, activity = caller.publication_turn_id, caller.bridge_activity
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_413_CONTENT_TOO_LARGE
                )
        try:
            command = PluginInstallation.model_validate_json(raw)
            if (
                resolve_caller(scope_id) is not caller
                or caller.publication_turn_id != turn_id
                or caller.bridge_activity is not activity
            ):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            result = await activities.finish(
                ActivityDomain.BRIDGE, lambda: caller.plugin_installation(command, turn_id=turn_id)
            )
            return JSONResponse({"ok": True, "result": result})
        except (ValueError, OSError) as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)

    @router.post(COMPONENT_ROUTE_PREFIX + "{operation}")
    async def component(request: Request, operation: str) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None or not caller.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
        turn_id = caller.publication_turn_id
        activity = caller.bridge_activity
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_413_CONTENT_TOO_LARGE
                )
        try:
            parameters = json.loads(raw)
            if operation == COMPONENT_CATALOG_OPERATION:
                command = ComponentCatalog.model_validate(parameters)
            elif operation == COMPONENT_PREFLIGHT_OPERATION:
                command = ComponentPreflight.model_validate(parameters)
            elif operation in {COMPONENT_REQUEST_OPERATION, COMPONENT_DISPLAY_OPERATION}:
                command = ComponentInvocation.model_validate(parameters)
            else:
                raise ValueError("component_operation_unknown")
            if (
                resolve_caller(scope_id) is not caller
                or caller.publication_turn_id != turn_id
                or caller.bridge_activity is not activity
            ):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            if isinstance(command, ComponentCatalog):
                result = {"ok": True, "components": caller.component_catalog()}
                if command.include_ui:
                    result["ui"] = caller.component_ui_catalog()
                return JSONResponse(result)
            if isinstance(command, ComponentPreflight):
                return JSONResponse(
                    {"ok": True, "result": caller.component_preflight(command.slots)}
                )
            result = await activities.finish(
                ActivityDomain.BRIDGE,
                lambda: caller.component_interaction(
                    command, turn_id=turn_id, waiting=operation == COMPONENT_REQUEST_OPERATION
                ),
            )
            return JSONResponse({"ok": True, "result": result})
        except ComponentValidationError as error:
            return JSONResponse(
                {"ok": False, "error": str(error), "detail": error.detail},
                HTTP_400_BAD_REQUEST,
            )
        except ValidationError:
            return JSONResponse(
                {"ok": False, "error": "bridge_invalid_parameters"}, HTTP_400_BAD_REQUEST
            )
        except ValueError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)

    @router.post(DISPLAY_CARD_ROUTE)
    async def display_card(request: Request) -> JSONResponse:
        caller = scoped_bridge_caller(request, resolve_caller)
        if caller is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
        activity = caller.bridge_activity
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
        if (
            resolve_caller(scope_id) is not caller
            or caller.publication_turn_id != turn_id
            or caller.bridge_activity is not activity
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            card = await activities.finish(
                ActivityDomain.BRIDGE,
                lambda: caller.display_card(command.type, command.content, turn_id=turn_id),
            )
        except DisplayCardError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        return JSONResponse({"ok": True, "card": card})

    app.include_router(router)
    return router
