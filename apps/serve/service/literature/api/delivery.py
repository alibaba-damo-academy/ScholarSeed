from __future__ import annotations

from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
)

from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.service.cards import DISPLAY_CARD_CONTINUE_ACTION, DISPLAY_CARD_LIMIT_ERRORS
from service.chat.service.sessions import SessionService
from service.identity.utils import request_owner_id, require_host_process
from service.literature.domain.delivery import (
    DELIVERY_CARD,
    DELIVERY_NOT_FOUND,
    DELIVERY_ROUTE,
    DeliveryCard,
    DeliveryChoice,
    DeliveryDirectory,
    DeliveryItemState,
    DeliveryTarget,
)
from service.literature.domain.utils import delivery_project_id
from service.literature.persistence.files import scoped_relative
from service.literature.service.delivery import DeliveryService
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_DELIVERY_ROUTE,
    DisplayCardContent,
    LiteratureDelivery,
)
from service.platform.content import ProjectRef
from service.platform.http_activity import execution_admission

DELIVERY_SESSION_NOT_FOUND = "session_not_found"
DELIVERY_REQUEST_INVALID = "literature_delivery_request_invalid"
DELIVERY_BRIDGE_DENIED = "bridge_access_denied"


def register_delivery_routes(
    app: FastAPI,
    sessions: SessionService,
    catalog: SessionCatalogStore,
    service: DeliveryService,
    project_for_session: Callable[[str], ProjectRef | None],
    *,
    activities: Activities,
) -> APIRouter:
    admission = [Depends(execution_admission(activities, ActivityDomain.LITERATURE))]
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    def require_session(request: Request, session_id: str) -> None:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, DELIVERY_SESSION_NOT_FOUND) from error

    def failure(error: ValueError | OSError) -> HTTPException:
        return HTTPException(
            HTTP_404_NOT_FOUND if str(error) == DELIVERY_NOT_FOUND else HTTP_409_CONFLICT,
            str(error),
        )

    @router.post(LITERATURE_DELIVERY_ROUTE)
    async def seal(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": DELIVERY_BRIDGE_DENIED}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        try:
            command = LiteratureDelivery.model_validate(await request.json())
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse(
                    {"ok": False, "error": DELIVERY_BRIDGE_DENIED}, HTTP_403_FORBIDDEN
                )
            value = await activities.to_thread(
                ActivityDomain.LITERATURE, service.seal, live.id, scoped_relative(command.run)
            )
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse(
                    {"ok": False, "error": DELIVERY_BRIDGE_DENIED}, HTTP_403_FORBIDDEN
                )
            card = DeliveryCard(
                session_id=live.id,
                delivery_id=value["id"],
                project_id=value["project_id"],
                count=len(value["papers"]),
            )
            await live.display_card(
                DELIVERY_CARD,
                DisplayCardContent(data=card.model_dump(mode="json")),
                turn_id=turn_id,
            )
        except ValueError as error:
            result = {"ok": False, "error": str(error)}
            if str(error) in DISPLAY_CARD_LIMIT_ERRORS:
                result["action"] = DISPLAY_CARD_CONTINUE_ACTION
            return JSONResponse(result, HTTP_400_BAD_REQUEST)
        return JSONResponse(
            {
                "ok": True,
                "delivery_id": value["id"],
                "state": value["state"],
                "acquired": len(value["papers"]),
                "saved": sum(
                    paper["saved"] == DeliveryItemState.SAVED for paper in value["papers"]
                ),
            }
        )

    @app.get(DELIVERY_ROUTE + "/{delivery_id}", dependencies=admission)
    async def read(session_id: str, delivery_id: str, request: Request) -> dict:
        require_session(request, session_id)
        try:
            return service.public(
                await activities.to_thread(
                    ActivityDomain.LITERATURE, service.get, session_id, delivery_id
                )
            )
        except ValueError as error:
            raise failure(error) from error

    @app.post(DELIVERY_ROUTE + "/{delivery_id}/prompt", dependencies=admission)
    async def prompt(session_id: str, delivery_id: str, request: Request) -> dict:
        require_session(request, session_id)
        try:
            return {
                "claimed": await activities.to_thread(
                    ActivityDomain.LITERATURE, service.prompt, session_id, delivery_id
                )
            }
        except ValueError as error:
            raise failure(error) from error

    @app.post(DELIVERY_ROUTE + "/{delivery_id}/cancel", dependencies=admission)
    async def cancel(session_id: str, delivery_id: str, request: Request) -> dict:
        require_session(request, session_id)
        try:
            return service.public(
                await activities.to_thread(
                    ActivityDomain.LITERATURE, service.cancel, session_id, delivery_id
                )
            )
        except ValueError as error:
            raise failure(error) from error

    @app.post(DELIVERY_ROUTE + "/{delivery_id}/directory", dependencies=admission)
    async def directory(
        session_id: str, delivery_id: str, command: DeliveryDirectory, request: Request
    ) -> dict:
        require_host_process(request)
        require_session(request, session_id)
        try:
            return await activities.to_thread(
                ActivityDomain.LITERATURE,
                service.choose_directory,
                session_id,
                delivery_id,
                command.absolute,
            )
        except (ValueError, OSError) as error:
            raise HTTPException(HTTP_409_CONFLICT, DELIVERY_REQUEST_INVALID) from error

    @app.post(DELIVERY_ROUTE + "/{delivery_id}/save", dependencies=admission)
    async def save(
        session_id: str, delivery_id: str, command: DeliveryChoice, request: Request
    ) -> dict:
        require_host_process(request)
        require_session(request, session_id)
        try:
            return service.public(
                await activities.to_thread(
                    ActivityDomain.LITERATURE, service.save, session_id, delivery_id, command
                )
            )
        except (ValueError, OSError) as error:
            raise failure(ValueError(str(error))) from error

    @app.post(DELIVERY_ROUTE + "/{delivery_id}/open", dependencies=admission)
    async def open_target(session_id: str, delivery_id: str, request: Request) -> dict:
        require_host_process(request)
        require_session(request, session_id)
        try:
            value = await activities.to_thread(
                ActivityDomain.LITERATURE, service.get, session_id, delivery_id
            )
            choice = value["choice"]
            if choice is None:
                raise ValueError(DELIVERY_REQUEST_INVALID)
            if choice["target"] == DeliveryTarget.DIRECTORY:
                absolute = await activities.to_thread(
                    ActivityDomain.LITERATURE, service.saved_directory, value
                )
            else:
                project = project_for_session(session_id)
                if (project.id if project is not None else "") != value["project_id"]:
                    raise ValueError(DELIVERY_REQUEST_INVALID)
                absolute = service.project_directory(delivery_project_id(value), choice["parent"])
            return {"absolute": absolute}
        except (ValueError, OSError) as error:
            raise failure(error) from error

    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        try:
            async with original_lifespan(application):
                yield
        finally:
            service.close()

    app.router.lifespan_context = lifespan
    app.include_router(router)
    return router
