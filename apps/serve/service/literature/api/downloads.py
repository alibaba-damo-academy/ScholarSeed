"""Session-scoped download admission and product-owned full-text cards."""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_404_NOT_FOUND,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from service.assistant.service.authorization import task_authorization_policy
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.runtime.live import LiveSession
from service.chat.service.cards import (
    DISPLAY_CARD_CONTINUE_ACTION,
    DISPLAY_CARD_LIMIT_ERRORS,
    DisplayCardError,
)
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import TASK_ACTIVATION_REQUIRED_ACTION
from service.identity.utils import request_owner_id
from service.literature.persistence.downloads import (
    DOWNLOAD_ADMISSION_UNAVAILABLE,
    DOWNLOAD_RECEIPT_INVALID,
    load_download_result,
    read_download_receipt,
    read_download_receipts,
    save_download_result,
)
from service.literature.persistence.files import scoped_relative
from service.literature.service.downloads import (
    DOWNLOADS_CARD,
    DownloadAdmission,
    DownloadCard,
    DownloadEntry,
    DownloadFailure,
    DownloadPaperView,
    DownloadScope,
    download_result_bytes,
    download_result_page,
    parse_download_cursor,
    prepare_download_scope,
    read_download_manifest,
    summarize_download_card,
)
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_INGEST_ROUTE,
    DisplayCardContent,
    LiteratureIngest,
)
from service.platform.context import ProductTaskType
from service.platform.http_activity import execution_admission
from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
)

logger = logging.getLogger(__name__)
DOWNLOAD_INGEST_FAILED = "download_ingest_failed"
DOWNLOAD_TURN_STALE = "download_turn_stale"
DOWNLOAD_TASK_REQUIRED = "download_task_required"
DOWNLOAD_READ_ROUTE = "/api/sessions/{session_id}/literature/downloads/{operation_id}"
DOWNLOAD_LIST_ROUTE = "/api/sessions/{session_id}/literature/downloads"
DOWNLOAD_SESSION_NOT_FOUND = "session_not_found"
DOWNLOAD_MAINTENANCE_ACTIVE = "update_maintenance"
DOWNLOAD_CARD_UNAVAILABLE = "download_card_unavailable"
DOWNLOAD_RECEIPT_UNAVAILABLE = "download_receipt_unavailable"
DOWNLOAD_SCOPE_PREPARERS = {ProductTaskType.PRECISE_SEARCH.value: prepare_download_scope}


@dataclass(frozen=True)
class DownloadContext:
    session_id: str
    project_id: str
    task_type: str
    snapshot_id: str
    turn_id: str
    client_turn_id: str
    workdir: Path

    @classmethod
    def capture(cls, live: LiveSession) -> DownloadContext:
        return cls(
            live.id,
            live.project_id or "",
            live.active_task_type,
            live.active_assistant_snapshot_id,
            live.publication_turn_id,
            getattr(live, "active_product_turn_id", ""),
            live.runtime_workdir,
        )

    def current(self, live: LiveSession, sessions: SessionService) -> bool:
        return sessions.bridge_caller(self.session_id) is live and self == self.capture(live)


def validate_download_context(
    context: DownloadContext,
    live: LiveSession,
    sessions: SessionService,
) -> None:
    if not context.current(live, sessions):
        raise ValueError(DOWNLOAD_TURN_STALE)
    if (
        context.task_type not in DOWNLOAD_SCOPE_PREPARERS
        or task_authorization_policy(context.task_type) is None
    ):
        raise ValueError(DOWNLOAD_TASK_REQUIRED)


async def admit_downloads(
    scope: DownloadScope,
    entries: tuple[DownloadEntry, ...],
    *,
    session_id: str,
    project_id: str,
    activities: Activities,
) -> DownloadCard:
    admission = DownloadAdmission()
    papers = []
    failures = []
    for entry in entries:
        try:
            receipt = await activities.to_thread(
                ActivityDomain.BRIDGE, admission.admit, scope, entry, session_id, project_id
            )
            papers.append(DownloadPaperView.model_validate(receipt.payload()))
        except (ValueError, OSError, sqlite3.Error) as error:
            logger.warning(
                "download_admission_failed session_id=%s paper_id=%s error=%s",
                session_id,
                entry.paper_id,
                error,
            )
            code = str(error) if isinstance(error, ValueError) else DOWNLOAD_ADMISSION_UNAVAILABLE
            failures.append(DownloadFailure(paper_id=entry.paper_id, code=code))
    return DownloadCard(
        session_id=session_id,
        run=scope.run,
        project_id=project_id,
        papers=papers,
        failures=failures,
    )


async def admit_live_downloads(
    live: LiveSession,
    sessions: SessionService,
    scope: DownloadScope,
    entries: tuple[DownloadEntry, ...],
    context: DownloadContext,
    activities: Activities,
) -> dict:
    validate_download_context(context, live, sessions)
    admitted = await admit_downloads(
        scope,
        entries,
        session_id=context.session_id,
        project_id=context.project_id,
        activities=activities,
    )
    result = admitted.model_dump(mode="json")
    result["delivery"] = (
        {"ok": False, "error": DOWNLOAD_TURN_STALE}
        if admitted.papers or admitted.failures
        else {"ok": True}
    )
    if (admitted.papers or admitted.failures) and context.current(live, sessions):
        try:
            summary = summarize_download_card(admitted)
            card = await live.display_card(
                DOWNLOADS_CARD,
                DisplayCardContent(data=summary.model_dump(mode="json")),
                turn_id=context.turn_id,
            )
            result["card_id"] = card["card_id"]
            result["delivery"] = {"ok": True}
        except (DisplayCardError, OSError, sqlite3.Error) as error:
            logger.warning("download_card_failed session_id=%s error=%s", live.id, error)
            code = str(error) if isinstance(error, DisplayCardError) else DOWNLOAD_CARD_UNAVAILABLE
            result["delivery"] = {"ok": False, "error": code}
            if code in DISPLAY_CARD_LIMIT_ERRORS:
                result["delivery"]["action"] = DISPLAY_CARD_CONTINUE_ACTION
    return {"ok": not admitted.failures, **result}


def register_download_routes(
    app: FastAPI,
    sessions: SessionService,
    catalog: SessionCatalogStore,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(LITERATURE_INGEST_ROUTE)
    async def ingest(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        context = DownloadContext.capture(live)
        try:
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                    raise ValueError("bridge_request_too_large")
            query = LiteratureIngest.model_validate(json.loads(raw))
            validate_download_context(context, live, sessions)
            if query.cursor is not None:
                receipt_id, offset = parse_download_cursor(query.cursor)
                result = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    load_download_result,
                    receipt_id,
                    context.session_id,
                    context.project_id,
                    scoped_relative(query.run),
                )
                validate_download_context(context, live, sessions)
                return JSONResponse(
                    download_result_page(result, receipt_id, offset, BRIDGE_MAX_RESPONSE_BYTES)
                )
            scope = await activities.to_thread(
                ActivityDomain.BRIDGE, prepare_download_scope, context.workdir, query.run
            )
            validate_download_context(context, live, sessions)
            entries = await activities.to_thread(
                ActivityDomain.BRIDGE, read_download_manifest, scope
            )
            result = await admit_live_downloads(live, sessions, scope, entries, context, activities)
            if len(download_result_bytes(result)) > BRIDGE_MAX_RESPONSE_BYTES:
                try:
                    receipt_id = await activities.to_thread(
                        ActivityDomain.BRIDGE, save_download_result, result
                    )
                except (OSError, sqlite3.Error) as error:
                    logger.warning("download_receipt_failed session_id=%s error=%s", live.id, error)
                    result["receipt_delivery"] = {
                        "ok": False,
                        "error": DOWNLOAD_RECEIPT_UNAVAILABLE,
                    }
                    result = download_result_page(result, "", 0, BRIDGE_MAX_RESPONSE_BYTES)
                else:
                    result = download_result_page(result, receipt_id, 0, BRIDGE_MAX_RESPONSE_BYTES)
            return JSONResponse(result)
        except (ValueError, OSError, sqlite3.Error) as error:
            logger.warning("download_ingest_rejected session_id=%s error=%s", live.id, error)
            reason = str(error)
            return JSONResponse(
                {
                    "ok": False,
                    "error": DOWNLOAD_INGEST_FAILED,
                    "reason": reason,
                    "recoverable": reason
                    not in (
                        DOWNLOAD_TURN_STALE,
                        DOWNLOAD_RECEIPT_INVALID,
                    ),
                    **(
                        {"action": TASK_ACTIVATION_REQUIRED_ACTION}
                        if reason == DOWNLOAD_TASK_REQUIRED
                        else {}
                    ),
                },
                HTTP_400_BAD_REQUEST,
            )

    app.include_router(router)

    @app.get(
        DOWNLOAD_READ_ROUTE,
        dependencies=[Depends(execution_admission(activities, ActivityDomain.LITERATURE))],
    )
    async def read(session_id: str, operation_id: str, request: Request) -> dict:
        try:
            await activities.to_thread(
                ActivityDomain.LITERATURE,
                catalog.require,
                session_id,
                SessionPrincipal(request_owner_id(request)),
            )
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, DOWNLOAD_SESSION_NOT_FOUND) from error
        try:
            receipt = await activities.to_thread(
                ActivityDomain.LITERATURE, read_download_receipt, operation_id, session_id
            )
        except sqlite3.Error as error:
            raise HTTPException(
                HTTP_503_SERVICE_UNAVAILABLE, DOWNLOAD_RECEIPT_UNAVAILABLE
            ) from error
        except (ValueError, OSError) as error:
            raise HTTPException(HTTP_404_NOT_FOUND, DOWNLOAD_RECEIPT_INVALID) from error
        if receipt is None:
            raise HTTPException(HTTP_404_NOT_FOUND, DOWNLOAD_RECEIPT_INVALID)
        return receipt.payload()

    @app.get(
        DOWNLOAD_LIST_ROUTE,
        dependencies=[Depends(execution_admission(activities, ActivityDomain.LITERATURE))],
    )
    async def history(session_id: str, run: str, project_id: str, request: Request) -> dict:
        try:
            await activities.to_thread(
                ActivityDomain.LITERATURE,
                catalog.require,
                session_id,
                SessionPrincipal(request_owner_id(request)),
            )
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, DOWNLOAD_SESSION_NOT_FOUND) from error
        try:
            receipts = await activities.to_thread(
                ActivityDomain.LITERATURE, read_download_receipts, session_id, run, project_id
            )
        except sqlite3.Error as error:
            raise HTTPException(
                HTTP_503_SERVICE_UNAVAILABLE, DOWNLOAD_RECEIPT_UNAVAILABLE
            ) from error
        except ValueError as error:
            raise HTTPException(HTTP_400_BAD_REQUEST, DOWNLOAD_RECEIPT_INVALID) from error
        return {
            "session_id": session_id,
            "run": run,
            "project_id": project_id,
            "papers": [receipt.payload() for receipt in receipts],
        }

    return router
