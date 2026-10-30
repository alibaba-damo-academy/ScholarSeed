"""Host-authorized settings transport for product-owned MCP configuration."""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.status import (
    HTTP_403_FORBIDDEN,
    HTTP_409_CONFLICT,
    HTTP_413_CONTENT_TOO_LARGE,
    HTTP_422_UNPROCESSABLE_CONTENT,
    HTTP_501_NOT_IMPLEMENTED,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
)
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import PRODUCT_PERMISSION_MODES, SessionService
from service.identity.utils import request_user_id, require_host_process
from service.platform.activity import Activities
from service.platform.bridge import (
    BRIDGE_CALLBACK_REQUEST_CHARS,
    BRIDGE_CALLBACK_REQUEST_HEADER,
    BRIDGE_CALLBACK_REQUEST_PATTERN,
    BRIDGE_CALLBACK_TURN_HEADER,
    BRIDGE_REQUESTS,
    MCP_BRIDGE_CAPABILITY,
    MCP_BRIDGE_ROUTE_PREFIX,
    MCP_BRIDGE_SCOPE,
)
from service.platform.mcp import (
    MCP_INVALID_CONFIG,
    McpApplyRequest,
    McpPlanRequest,
    McpServer,
    McpStatusRequest,
)
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES
from service.settings.mcp import (
    MCP_APPLICATION_FAILED,
    MCP_CONFIG_TOO_LARGE,
    MCP_CREDENTIALS_UNAVAILABLE,
    MCP_INITIAL_REVISION,
    MCP_MAX_CONFIG_BYTES,
    MCP_MAX_SERVERS,
    McpConfigurationConflict,
    McpConfigurationService,
    McpConfigurationUnsupported,
    McpConfigurationView,
)
from service.settings.plans import (
    MCP_PLAN_ACCESS_DENIED,
    McpPlan,
    McpPlanOrigin,
    McpPlanService,
)

MCP_SETTINGS_ROUTE = "/api/settings/mcp"
MCP_STORAGE_UNAVAILABLE = "mcp_storage_unavailable"
MCP_BRIDGE_ACCESS_DENIED = "mcp_bridge_access_denied"
MCP_BRIDGE_PERMISSION_DENIED = "mcp_bridge_permission_denied"
MCP_BRIDGE_MODE_FIELD = "mode"
MCP_BRIDGE_ACTIVE_MODE_FIELD = "active_mode"


class McpReplaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)

    expected_revision: int = Field(ge=MCP_INITIAL_REVISION)
    servers: tuple[McpServer, ...] = Field(max_length=MCP_MAX_SERVERS)
    wait_for_application: bool = False


def _http_error(error: ValueError | RuntimeError | OSError) -> HTTPException:
    reason = str(getattr(error, "safe_error", "") or error)
    if reason in {
        RESOURCE_HOST_BUSY,
        RESOURCE_HOST_CONFIGURATION_CONFLICT,
        RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    }:
        return HTTPException(HTTP_409_CONFLICT, reason)
    if reason == RESOURCE_HOST_CONTEXT_REQUIRED:
        return HTTPException(HTTP_503_SERVICE_UNAVAILABLE, reason)
    if isinstance(error, RuntimeError):
        return HTTPException(HTTP_503_SERVICE_UNAVAILABLE, MCP_APPLICATION_FAILED)
    if isinstance(error, McpConfigurationConflict):
        return HTTPException(HTTP_409_CONFLICT, str(error))
    if isinstance(error, McpConfigurationUnsupported):
        return HTTPException(HTTP_501_NOT_IMPLEMENTED, str(error))
    if isinstance(error, OSError):
        return HTTPException(HTTP_503_SERVICE_UNAVAILABLE, MCP_STORAGE_UNAVAILABLE)
    reason = (
        MCP_CREDENTIALS_UNAVAILABLE
        if str(error) == MCP_CREDENTIALS_UNAVAILABLE
        else MCP_INVALID_CONFIG
    )
    return HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, reason)


def mount_mcp_routes(app: FastAPI, service: McpConfigurationService) -> None:
    @app.get(MCP_SETTINGS_ROUTE, dependencies=[Depends(require_host_process)])
    async def status(request: Request) -> McpConfigurationView:
        try:
            async with app.state.runtime_service.host_control(user_id=request_user_id(request)):
                return await service.status()
        except (ValueError, RuntimeError, OSError) as error:
            raise _http_error(error) from None

    @app.put(MCP_SETTINGS_ROUTE, dependencies=[Depends(require_host_process)])
    async def replace(request: Request) -> McpConfigurationView:
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > MCP_MAX_CONFIG_BYTES:
                raise HTTPException(HTTP_413_CONTENT_TOO_LARGE, MCP_CONFIG_TOO_LARGE)
        try:
            update = McpReplaceRequest.model_validate_json(payload)
        except ValidationError:
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, MCP_INVALID_CONFIG) from None
        try:
            async with app.state.runtime_service.host_control(user_id=request_user_id(request)):
                result = await service.replace(
                    update.servers, expected_revision=update.expected_revision
                )
                return (
                    await service.wait_application(result)
                    if update.wait_for_application
                    else result
                )
        except (ValueError, RuntimeError, OSError) as error:
            raise _http_error(error) from None


def register_mcp_bridge(
    app: FastAPI,
    sessions: SessionService,
    service: McpConfigurationService,
    plans: McpPlanService,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    def configuration_payload(view: McpConfigurationView) -> dict:
        return {
            "revision": view.configuration.revision,
            "supported": view.supported,
            "state": view.state.value,
            "safe_error": view.safe_error,
            "scope": MCP_BRIDGE_SCOPE,
            "server_statuses": [status.model_dump(mode="json") for status in view.servers],
            "servers": [
                {
                    "id": server.id,
                    "name": server.name,
                    "transport": server.transport,
                    "enabled": server.enabled,
                }
                for server in view.configuration.servers
            ],
        }

    def plan_payload(plan: McpPlan) -> dict:
        return {
            "plan_id": plan.plan_id,
            "plan_digest": plan.plan_digest,
            "state": plan.state.value,
            "expected_revision": plan.request.expected_revision,
            "target_revision": plan.target.revision,
            "mutation": plan.request.mutation.model_dump(mode="json"),
        }

    async def execute(operation: str, request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.active_product_turn_id or not live.publication_turn_id:
            raise HTTPException(HTTP_403_FORBIDDEN, MCP_BRIDGE_ACCESS_DENIED)
        turn_id = live.publication_turn_id
        product_turn_id = live.active_product_turn_id
        generation = live.product_turn_generation
        interrupt_generation = live.interrupt_generation
        attachment_generation = live.attachment_generation
        activity = live.turn_activity
        token = live.bridge_token
        callback = request.headers.get(BRIDGE_CALLBACK_REQUEST_HEADER, "")
        if (
            not callback
            or len(callback) > BRIDGE_CALLBACK_REQUEST_CHARS
            or not BRIDGE_CALLBACK_REQUEST_PATTERN.fullmatch(callback)
            or request.headers.get(BRIDGE_CALLBACK_TURN_HEADER, "") != turn_id
        ):
            raise HTTPException(HTTP_403_FORBIDDEN, MCP_BRIDGE_ACCESS_DENIED)

        def current() -> None:
            if (
                bridge_caller(request, sessions) is not live
                or live.publication_turn_id != turn_id
                or live.active_product_turn_id != product_turn_id
                or live.product_turn_generation != generation
                or live.interrupt_generation != interrupt_generation
                or live.attachment_generation != attachment_generation
                or live.turn_activity is not activity
                or live.bridge_token != token
            ):
                raise HTTPException(HTTP_403_FORBIDDEN, MCP_BRIDGE_ACCESS_DENIED)

        def authorize() -> None:
            current()
            mode = sessions.mode(live.id)
            if (
                mode.get(MCP_BRIDGE_MODE_FIELD) not in PRODUCT_PERMISSION_MODES
                or mode.get(MCP_BRIDGE_ACTIVE_MODE_FIELD) not in PRODUCT_PERMISSION_MODES
            ):
                raise HTTPException(HTTP_403_FORBIDDEN, MCP_BRIDGE_PERMISSION_DENIED)

        entry = BRIDGE_REQUESTS.get((MCP_BRIDGE_CAPABILITY, operation))
        if entry is None:
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, MCP_INVALID_CONFIG)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > BRIDGE_MAX_REQUEST_BYTES:
                raise HTTPException(HTTP_413_CONTENT_TOO_LARGE, MCP_CONFIG_TOO_LARGE)
        try:
            command = entry.request_type.model_validate_json(body)
        except ValueError:
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, MCP_INVALID_CONFIG) from None
        current()
        origin = McpPlanOrigin(session_id=live.id, turn_id=product_turn_id, request_id=callback)
        try:
            async with app.state.runtime_service.host_control(
                cwd=live.runtime_workdir,
                user_id=live.user_id,
                model_id=live.model_id,
                process_environment=live.process_environment,
            ):
                current()
                if isinstance(command, McpPlanRequest):
                    plan = await plans.create(command, origin)
                    current()
                    result = {"plan": plan_payload(plan)}
                elif isinstance(command, McpApplyRequest):
                    application = await plans.apply(command, origin, authorize=authorize)
                    result = {
                        "plan": plan_payload(application.plan),
                        "configuration": configuration_payload(application.configuration),
                    }
                elif isinstance(command, McpStatusRequest):
                    view = await service.status()
                    result = {"configuration": configuration_payload(view)}
                    if command.plan_id is not None:
                        plan = await plans.read(command.plan_id, session_id=live.id)
                        result["plan"] = plan_payload(plan)
                    current()
                else:
                    raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, MCP_INVALID_CONFIG)
        except (ValueError, RuntimeError, OSError) as error:
            if str(error) == MCP_PLAN_ACCESS_DENIED:
                raise HTTPException(HTTP_403_FORBIDDEN, MCP_BRIDGE_ACCESS_DENIED) from None
            raise _http_error(error) from None
        return JSONResponse({"ok": True, **result})

    @router.post(MCP_BRIDGE_ROUTE_PREFIX + "{operation}")
    async def operate(operation: str, request: Request) -> JSONResponse:
        try:
            return await execute(operation, request)
        except HTTPException as error:
            return JSONResponse({"ok": False, "error": error.detail}, status_code=error.status_code)

    app.include_router(router)
    return router
