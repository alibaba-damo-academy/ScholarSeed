"""Explicit active-session registration of generated literature evidence."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import FulltextAuthorizer, task_authorization_policy
from service.chat.api.bridge import bridge_caller
from service.chat.service.sessions import SessionService
from service.literature.domain.cards import CARD_MAX_BYTES, LIBRARY_REF_PREFIX, normalize_bundle
from service.literature.persistence.cards import PaperCards
from service.literature.persistence.files import read_scoped_file
from service.literature.persistence.store import LiteratureRepository
from service.platform.bridge import (
    BRIDGE_MAX_REQUEST_BYTES,
    PAPERCARD_REGISTER_OPERATION,
    PDF_ROUTE_PREFIX,
    PaperCardRegister,
)

CARD_REGISTERED_EVENT = "literature.card_registered"
CARD_ORIGIN_SESSION = "session:"


def prepare_bundle(root: Path, relative: str) -> dict:
    raw = json.loads(read_scoped_file(root, relative, CARD_MAX_BYTES))
    if not isinstance(raw, dict):
        raise ValueError("papercard_invalid")
    normalized = normalize_bundle(raw)
    if normalized["invalid_fields"]:
        raise ValueError("papercard_invalid_fields")
    return raw


def register_card_bridge(
    app: FastAPI, sessions: SessionService, authorizer: FulltextAuthorizer | None = None
) -> APIRouter:
    router = APIRouter()
    repository = LiteratureRepository()
    cards = PaperCards(repository.database)

    @router.post(PDF_ROUTE_PREFIX + PAPERCARD_REGISTER_OPERATION)
    async def register(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse({"error": "bridge_request_too_large"}, HTTP_400_BAD_REQUEST)
        try:
            command = PaperCardRegister.model_validate(json.loads(raw))
            if not command.ref_id.startswith(LIBRARY_REF_PREFIX):
                raise ValueError("literature_reference_required")
            literature_id = command.ref_id.removeprefix(LIBRARY_REF_PREFIX)
            item = repository.get(literature_id)
            if item is None:
                raise ValueError("literature_not_found")
            policy = task_authorization_policy(getattr(live, "active_task_type", ""))
            if policy is not None:
                if authorizer is None:
                    raise ValueError("fulltext_authorization_unavailable")
                authorizer.require(
                    session_id=live.id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    turn_id=turn_id,
                    authorization_type=policy.authorization_type,
                    ref_id=command.ref_id,
                    client_turn_id=getattr(live, "active_product_turn_id", ""),
                )
            bundle = await asyncio.to_thread(prepare_bundle, live.runtime_workdir, command.path)
            title = " ".join(str(bundle["paper_card"].get("title", "")).split()).casefold()
            if not title or title != " ".join(item.title.split()).casefold():
                raise ValueError("papercard_literature_identity_mismatch")
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse({"error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
            card = cards.save(literature_id, bundle, CARD_ORIGIN_SESSION + live.id)
            result = {
                "ok": True,
                "ref_id": command.ref_id,
                "card_revision": card["revision"],
                "sentence_count": len(card["sentences"]),
                "registered": True,
            }
        except (ValueError, OSError, RecursionError) as error:
            return JSONResponse({"error": str(error)}, HTTP_400_BAD_REQUEST)
        await live.publish(
            CARD_REGISTERED_EVENT,
            result,
            turn_id=turn_id,
            idempotency_key=f"card:{literature_id}:{card['revision']}",
        )
        return JSONResponse(result)

    app.include_router(router)
    return router
