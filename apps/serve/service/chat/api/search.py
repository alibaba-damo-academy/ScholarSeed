"""Authenticated turn-bound web search without shell-output provenance."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from scholarseed_runtime.contract import RuntimePermissionMode
from service.chat.api.bridge import bridge_caller
from service.chat.constants import PRODUCT_EVENT_SOURCE_CANDIDATES
from service.chat.service.search import SearchInterrupted, SearchService
from service.chat.service.sessions import SessionService
from service.invocation.service.artifacts import InvocationArtifactError
from service.invocation.service.runtime import INVOCATION_PERMISSION_EXCEEDS_PARENT, InvocationError
from service.invocation.service.skills import InvocationSkillError, InvocationSkillRuntimeError
from service.platform.bridge import BRIDGE_MAX_REQUEST_BYTES, SEARCH_ROUTE, WebSearchRequest


def register_conversation_search_routes(
    app: FastAPI,
    sessions: SessionService,
    searches: SearchService,
    can_search: Callable[[str, str], bool],
) -> APIRouter:
    router = APIRouter()

    @router.post(SEARCH_ROUTE)
    async def search(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        record = live.catalog.get(live.id)
        if record is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        generation = live.interrupt_generation
        attachment = live.attachment_generation

        def current() -> bool:
            return (
                sessions.bridge_caller(live.id) is live
                and live.publication_turn_id == turn_id
                and live.interrupt_generation == generation
                and live.attachment_generation == attachment
            )

        if not current() or not can_search(live.id, turn_id):
            return JSONResponse({"ok": False, "error": "search_not_allowed"}, HTTP_403_FORBIDDEN)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_400_BAD_REQUEST
                )

        async def publish(result: dict) -> None:
            if not current():
                raise SearchInterrupted()
            await live.publish(
                PRODUCT_EVENT_SOURCE_CANDIDATES,
                {
                    "search_id": result["search_id"],
                    "provider": result["provider"],
                    "query": result["query"],
                    "results": result["candidates"],
                    "result_count": len(result["candidates"]),
                    "results_truncated": result["truncated"],
                },
                turn_id=turn_id,
                item_id=result["search_id"],
                idempotency_key=f"search:{turn_id}:{result['search_id']}",
            )

        try:
            command = WebSearchRequest.model_validate(json.loads(raw))
            mode = RuntimePermissionMode(
                live.applied_permission_mode or RuntimePermissionMode.ASK.value
            )
            result = await searches.run(
                command,
                owner_id=record.principal_id,
                user_id=live.user_id,
                permission=live.permission_intent(mode),
                current=current,
                publish=publish,
            )
        except SearchInterrupted:
            return JSONResponse(
                {"ok": False, "status": "interrupted", "error": "search_interrupted"}
            )
        except InvocationError as error:
            status = (
                "action_required"
                if error.code == INVOCATION_PERMISSION_EXCEEDS_PARENT
                else "failed"
            )
            return JSONResponse({"ok": False, "status": status, "error": error.code})
        except InvocationSkillError as error:
            return JSONResponse({"ok": False, "status": "action_required", "error": error.code})
        except (InvocationArtifactError, InvocationSkillRuntimeError) as error:
            return JSONResponse({"ok": False, "status": "failed", "error": error.code})
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "search_request_or_result_invalid"}, HTTP_400_BAD_REQUEST
            )
        return JSONResponse(result)

    app.include_router(router)
    return router
