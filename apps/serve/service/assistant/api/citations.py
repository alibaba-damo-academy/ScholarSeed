"""Active-turn PDF bridge; grants are committed only within the validated scope."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    FulltextAuthorizer,
    authorization_question,
    task_authorization_policy,
)
from service.assistant.service.citations import CitationService
from service.chat.api.bridge import bridge_caller
from service.chat.runtime.live import LiveSession
from service.chat.service.sessions import SessionService
from service.content.domain.model import ContentError
from service.platform.bridge import (
    ANNOTATIONS_OPERATION,
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
    LITERATURE_READING_REQUESTS,
    LITERATURE_ROUTE_PREFIX,
    PDF_MATERIALIZE_OPERATION,
    PDF_REQUESTS,
    PDF_ROUTE_PREFIX,
    LiteratureAnnotations,
    LiteratureAuthorize,
    LiteratureList,
    LiteratureRead,
    PdfAnnotations,
    PdfMaterialize,
    PdfQuery,
)
from service.platform.citations import PdfMaterialization, PdfMaterializerPort

PDF_RETRIEVED_EVENT = "pdf.retrieved"
PDF_MATERIALIZED_EVENT = "pdf.materialized"
LITERATURE_RETRIEVED_EVENT = "literature.retrieved"
PDF_METADATA_OPERATIONS = frozenset(("list", "library"))
LITERATURE_CONTENT_OPERATIONS = frozenset(("read", ANNOTATIONS_OPERATION))


async def _request_body(request: Request) -> bytes:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
            raise ValueError("bridge_request_too_large")
    return bytes(raw)


def _active_scope(
    sessions: SessionService, live: LiveSession, snapshot_id: str, turn_id: str
) -> bool:
    return (
        sessions.bridge_caller(live.id) is live
        and live.active_assistant_snapshot_id == snapshot_id
        and live.ledger.active_turn_id == turn_id
    )


def register_citation_bridge(
    app: FastAPI,
    sessions: SessionService,
    citations: CitationService,
    authorizer: FulltextAuthorizer | None = None,
    materializer: PdfMaterializerPort | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post(PDF_ROUTE_PREFIX + "{operation}")
    async def query_pdf(operation: str, request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        snapshot_id, turn_id = live.active_assistant_snapshot_id, live.ledger.active_turn_id
        policy = task_authorization_policy(getattr(live, "active_task_type", ""))
        try:
            raw = await _request_body(request)
            query_type = PDF_REQUESTS.get(operation)
            if query_type is None:
                raise ValueError("bridge_operation_unknown")
            query = query_type.model_validate(json.loads(raw))
            # Parsing runs separately. This short, synchronous section checks scope,
            # consumes only a ready index and commits exactly the returned fragments.
            if not _active_scope(sessions, live, snapshot_id, turn_id):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            if policy is not None and operation not in PDF_METADATA_OPERATIONS:
                if authorizer is None:
                    raise ValueError("fulltext_authorization_unavailable")
                authorizer.require(
                    session_id=live.id,
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=policy.authorization_type,
                    ref_id=str(getattr(query, "ref_id", "")),
                    client_turn_id=getattr(live, "active_product_turn_id", ""),
                )
            materialized: PdfMaterialization | None = None
            materialize_request: PdfMaterialize | None = None
            prepared: dict[str, Any] | None = None
            if operation == PDF_MATERIALIZE_OPERATION:
                if materializer is None or not isinstance(query, PdfMaterialize):
                    raise ValueError("pdf_materializer_unavailable")
                materialize_request = query
                resolved = citations.document(
                    live.id,
                    snapshot_id,
                    PdfQuery(ref_id=query.ref_id, path=query.path, retry=query.retry),
                    turn_id,
                )
                materialized = await asyncio.to_thread(materializer.prepare, resolved.document)
            elif policy is not None and operation == "library":
                if not isinstance(query, PdfQuery):
                    raise ValueError("bridge_operation_unknown")
                prepared = await asyncio.to_thread(
                    citations.metadata_library, live.id, snapshot_id, query
                )
            elif operation == ANNOTATIONS_OPERATION:
                if not isinstance(query, PdfAnnotations):
                    raise ValueError("bridge_operation_unknown")
                prepared = await asyncio.to_thread(
                    citations.pdf_annotations, live.id, snapshot_id, query, turn_id
                )
            else:
                if not isinstance(query, PdfQuery):
                    raise ValueError("bridge_operation_unknown")
                prepared = await asyncio.to_thread(
                    citations.query, live.id, snapshot_id, operation, query, turn_id
                )
            if not _active_scope(sessions, live, snapshot_id, turn_id):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            result: dict[str, Any]
            if (
                materialized is not None
                and materializer is not None
                and materialize_request is not None
            ):
                result = materializer.publish(
                    materialized, live.runtime_workdir, materialize_request.target
                )
                result["ref_id"] = materialize_request.ref_id
            else:
                if prepared is None:
                    raise ValueError("bridge_operation_unknown")
                result = citations.commit_read(live.id, snapshot_id, prepared)
        except (ValueError, ContentError, OSError) as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        response = JSONResponse(result)
        if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
            return JSONResponse(
                {"ok": False, "error": "bridge_response_too_large; reduce limit"},
                HTTP_400_BAD_REQUEST,
            )
        event_payload: dict[str, Any] = {"operation": operation, "snapshot_id": snapshot_id}
        if operation == PDF_MATERIALIZE_OPERATION:
            event_payload.update(
                {
                    "target": result["target"],
                    "revision": result["revision"],
                    "digest": result["digest"],
                    "page_count": result["page_count"],
                }
            )
        else:
            event_payload["citation_urls"] = [
                fragment["citation_url"] for fragment in result.get("fragments", [])
            ]
        await live.publish(
            (
                PDF_MATERIALIZED_EVENT
                if operation == PDF_MATERIALIZE_OPERATION
                else PDF_RETRIEVED_EVENT
            ),
            event_payload,
            turn_id=turn_id,
            idempotency_key=f"pdf:{uuid.uuid4().hex}",
        )
        return response

    async def query_literature(operation: str, request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        snapshot_id, turn_id = live.active_assistant_snapshot_id, live.ledger.active_turn_id
        policy = task_authorization_policy(getattr(live, "active_task_type", ""))
        try:
            raw = await _request_body(request)
            request_type = LITERATURE_READING_REQUESTS[operation]
            query = request_type.model_validate(json.loads(raw))
            if not _active_scope(sessions, live, snapshot_id, turn_id):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            if operation == "authorize":
                if not isinstance(query, LiteratureAuthorize):
                    raise ValueError("bridge_operation_unknown")
                if policy is None:
                    raise ValueError("fulltext_authorization_task_required")
                if query.authorization_type != policy.authorization_type:
                    raise ValueError("fulltext_authorization_type_mismatch")
                if authorizer is None:
                    raise ValueError("fulltext_authorization_unavailable")
                sources = citations.authorization_sources(
                    live.id, snapshot_id, turn_id, tuple(query.refs)
                )
                authorization = authorizer.prepare(
                    session_id=live.id,
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=query.authorization_type,
                    refs=tuple(source["ref_id"] for source in sources),
                )
                prepared = {
                    "ok": True,
                    "authorization_type": authorization.authorization_type,
                    "scope_digest": authorization.scope_digest,
                    "sources": sources,
                    "question": authorization_question(authorization),
                }
            else:
                if operation in LITERATURE_CONTENT_OPERATIONS and policy is not None:
                    if not isinstance(query, (LiteratureRead, LiteratureAnnotations)):
                        raise ValueError("bridge_operation_unknown")
                    if authorizer is None:
                        raise ValueError("fulltext_authorization_unavailable")
                    authorizer.require(
                        session_id=live.id,
                        snapshot_id=snapshot_id,
                        turn_id=turn_id,
                        authorization_type=policy.authorization_type,
                        ref_id=query.ref_id,
                        client_turn_id=getattr(live, "active_product_turn_id", ""),
                    )
                if operation == "list":
                    if not isinstance(query, LiteratureList):
                        raise ValueError("bridge_operation_unknown")
                    prepared = await asyncio.to_thread(
                        citations.literature_list, live.id, snapshot_id, query
                    )
                elif operation == ANNOTATIONS_OPERATION:
                    if not isinstance(query, LiteratureAnnotations):
                        raise ValueError("bridge_operation_unknown")
                    prepared = await asyncio.to_thread(
                        citations.literature_annotations, live.id, snapshot_id, query
                    )
                else:
                    if not isinstance(query, LiteratureRead):
                        raise ValueError("bridge_operation_unknown")
                    prepared = await asyncio.to_thread(
                        citations.literature_read, live.id, snapshot_id, query, turn_id
                    )
            if not _active_scope(sessions, live, snapshot_id, turn_id):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            result: dict[str, Any] = (
                prepared
                if operation in ("list", "authorize", ANNOTATIONS_OPERATION)
                else citations.commit_literature_read(live.id, snapshot_id, prepared)
            )
        except (KeyError, ValueError, ContentError, OSError) as error:
            code = "bridge_operation_unknown" if isinstance(error, KeyError) else str(error)
            return JSONResponse({"ok": False, "error": code}, HTTP_400_BAD_REQUEST)
        response = JSONResponse(result)
        if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
            return JSONResponse(
                {"ok": False, "error": "bridge_response_too_large; reduce page range"},
                HTTP_400_BAD_REQUEST,
            )
        await live.publish(
            LITERATURE_RETRIEVED_EVENT,
            {
                "operation": operation,
                "snapshot_id": snapshot_id,
                "ref_id": result.get("ref_id", ""),
                "pages": [page["page"] for page in result.get("pages", [])],
                "citation_urls": [
                    page["citation_url"]
                    for page in result.get("pages", [])
                    if page.get("citation_url")
                ],
            },
            turn_id=turn_id,
            idempotency_key=f"literature:{uuid.uuid4().hex}",
        )
        return response

    @router.post(LITERATURE_ROUTE_PREFIX + "list")
    async def list_literature(request: Request) -> JSONResponse:
        return await query_literature("list", request)

    @router.post(LITERATURE_ROUTE_PREFIX + "read")
    async def read_literature(request: Request) -> JSONResponse:
        return await query_literature("read", request)

    @router.post(LITERATURE_ROUTE_PREFIX + "authorize")
    async def authorize_literature(request: Request) -> JSONResponse:
        return await query_literature("authorize", request)

    @router.post(LITERATURE_ROUTE_PREFIX + ANNOTATIONS_OPERATION)
    async def literature_annotations(request: Request) -> JSONResponse:
        return await query_literature(ANNOTATIONS_OPERATION, request)

    app.include_router(router)
    return router
