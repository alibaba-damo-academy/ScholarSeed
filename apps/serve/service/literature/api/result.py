"""Publish skill results through the existing active-session card transport."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Literal

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN, HTTP_404_NOT_FOUND

from service.assistant.service.authorization import (
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
)
from service.chat.api.bridge import bridge_caller
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.live import LiveSession
from service.chat.service.artifacts import ArtifactReadError, ArtifactService
from service.chat.service.cards import DisplayCardError, session_cards
from service.chat.service.sessions import SessionService
from service.identity.utils import request_owner_id
from service.literature.api.gate import authorize_sources, publish_checkpoint_card
from service.literature.persistence.files import scoped_relative
from service.literature.service.agentic import project_agentic_papers
from service.literature.service.checkpoint import policy_for
from service.literature.service.result import (
    AGENTIC_SEARCH_ORIGIN,
    ARTIFACT_REFERENCE_FIELDS,
    LITERATURE_REVIEW_ORIGINS,
    SEARCH_CARD,
    SELECTION_NOT_PREPARED,
    prepare_final_delivery,
    prepare_result,
    project_papers,
    project_selected_papers,
)
from service.literature.service.review import (
    CORPUS,
    FULLTEXT,
    METADATA,
    RETRIEVAL,
    project_review_search_artifacts,
)
from service.literature.service.status import ResultStatusRequest, ResultStatusService
from service.platform.bridge import (
    BRIDGE_MAX_REQUEST_BYTES,
    LITERATURE_RESULT_ROUTE,
    ArtifactPublishFailure,
    DisplayCardContent,
    LiteratureResultPublish,
)
from service.platform.context import ProductTaskType

RESULT_STATUS_ROUTE = "/api/sessions/{session_id}/literature/result-status"
RESULT_REPORT_ROLE = "supporting"
AGENTIC_CANDIDATES_CHECKPOINT = "candidates"
AGENTIC_METADATA_FILE = "metadata.json"
FINAL_DELIVERY_CHECKPOINT: Literal["final"] = "final"
SELECTION_CHECKPOINT: Literal["selection"] = "selection"
PRECISE_TASK_CHECKPOINTS = frozenset((SELECTION_CHECKPOINT, FINAL_DELIVERY_CHECKPOINT))
FULLTEXT_AUTHORIZATION_TASK_REQUIRED = "fulltext_authorization_task_required"
RESULT_ARTIFACT_INVALID = "literature_result_artifact_invalid"
RESULT_PUBLICATION_FAILED = "literature_result_publication_failed"
SELECTION_PREPARE_ACTION = "prepare and register the confirmed selection before retrying"
TASK_CONTEXT_ACTION = "retry from the active precise search task"
RESULT_RETRY_ACTION = "check the search run artifacts and retry"
UNKNOWN_CHECKPOINT = "unknown"

logger = logging.getLogger(__name__)


def register_result_routes(
    app: FastAPI,
    sessions: SessionService,
    catalog: SessionCatalogStore,
    statuses: ResultStatusService,
    events: ProductEventStore | None = None,
    artifacts: ArtifactService | None = None,
    authorizer: FulltextAuthorizer | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post(LITERATURE_RESULT_ROUTE)
    async def publish_result(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        checkpoint = UNKNOWN_CHECKPOINT
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_400_BAD_REQUEST
                )
        try:
            command = LiteratureResultPublish.model_validate(json.loads(raw))
            checkpoint = command.checkpoint
            if command.checkpoint == AGENTIC_CANDIDATES_CHECKPOINT:
                return await publish_candidates(live, turn_id, command.run)
            active_task_type = getattr(live, "active_task_type", "")
            if (
                command.checkpoint in PRECISE_TASK_CHECKPOINTS
                and active_task_type
                and active_task_type != ProductTaskType.PRECISE_SEARCH.value
            ):
                raise ValueError(FULLTEXT_AUTHORIZATION_TASK_REQUIRED)
            if command.checkpoint == FINAL_DELIVERY_CHECKPOINT:
                return await publish_final_delivery(live, turn_id, command.run)
            result_checkpoint: Literal["search", "selection"] = (
                SELECTION_CHECKPOINT if command.checkpoint == SELECTION_CHECKPOINT else "search"
            )
            prepared = await asyncio.to_thread(
                prepare_result, live.runtime_workdir, command.run, result_checkpoint
            )
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            report = await live.publish_artifact(
                prepared.report_path,
                RESULT_REPORT_ROLE,
                turn_id=turn_id,
                expected_sha256=prepared.report_sha256,
            )
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            metadata = await live.publish_artifact(
                prepared.metadata_path,
                RESULT_REPORT_ROLE,
                turn_id=turn_id,
                expected_sha256=prepared.metadata_sha256,
            )
            selection = None
            if prepared.selection_path and prepared.selection_sha256:
                selection = await live.publish_artifact(
                    prepared.selection_path,
                    RESULT_REPORT_ROLE,
                    turn_id=turn_id,
                    expected_sha256=prepared.selection_sha256,
                )
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            content = prepared.card.model_copy(
                update={
                    "session_id": live.id,
                    "report": {key: report.get(key) for key in ARTIFACT_REFERENCE_FIELDS},
                    "metadata": {key: metadata.get(key) for key in ARTIFACT_REFERENCE_FIELDS},
                    "selection": (
                        {key: selection.get(key) for key in ARTIFACT_REFERENCE_FIELDS}
                        if selection
                        else {}
                    ),
                }
            ).model_dump(mode="json")
            card = await live.display_card(
                SEARCH_CARD, DisplayCardContent(data=content), turn_id=turn_id
            )
            authorization = None
            if command.checkpoint == SELECTION_CHECKPOINT and prepared.authorization_refs:
                if authorizer is None:
                    raise ValueError("fulltext_authorization_unavailable")
                challenge, disposition, decision = await authorize_sources(
                    live,
                    authorizer,
                    turn_id=turn_id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    authorization_type=PRECISE_SEARCH_FULLTEXT,
                    refs=prepared.authorization_refs,
                )
                if decision is not None and (
                    sessions.bridge_caller(live.id) is not live
                    or live.publication_turn_id != turn_id
                ):
                    return JSONResponse(
                        {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                    )
                authorization = {
                    "authorization_type": challenge.authorization_type,
                    "scope_digest": challenge.scope_digest,
                    "sources": [
                        {"id": source.id, "title": source.title}
                        for source in prepared.authorization_sources
                    ],
                    "disposition": disposition.value,
                }
        except (ValueError, OSError, DisplayCardError, ArtifactPublishFailure) as error:
            logger.warning(
                "literature_result_publication_failed session_id=%s checkpoint=%s "
                "failure_type=%s failure=%s",
                live.id,
                checkpoint,
                type(error).__name__,
                str(error)[:200] if isinstance(error, ValueError) else "",
            )
            reason = (
                str(error)
                if isinstance(error, ValueError) and str(error)
                else RESULT_ARTIFACT_INVALID
            )
            action = RESULT_RETRY_ACTION
            if reason == SELECTION_NOT_PREPARED:
                action = SELECTION_PREPARE_ACTION
            elif reason == FULLTEXT_AUTHORIZATION_TASK_REQUIRED:
                action = TASK_CONTEXT_ACTION
            return JSONResponse(
                {
                    "ok": False,
                    "error": RESULT_PUBLICATION_FAILED,
                    "reason": reason,
                    "recoverable": isinstance(error, ValueError),
                    "action": action,
                },
                HTTP_400_BAD_REQUEST,
            )
        return JSONResponse(
            {
                "ok": True,
                "card_id": card["card_id"],
                "retained": prepared.card.retained,
                "status": prepared.card.status,
                **({"authorization": authorization} if authorization is not None else {}),
            }
        )

    async def publish_final_delivery(live: LiveSession, turn_id: str, run: str) -> JSONResponse:
        """Publish the terminal answer and its supporting evidence from one bound run."""

        prepared = await asyncio.to_thread(prepare_final_delivery, live.runtime_workdir, run)
        published = []
        for artifact in prepared.artifacts:
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            reference = await live.publish_artifact(
                artifact.path,
                artifact.role,
                turn_id=turn_id,
                expected_sha256=artifact.sha256,
            )
            published.append(
                {
                    **{key: reference.get(key) for key in ARTIFACT_REFERENCE_FIELDS},
                    "role": artifact.role,
                }
            )
        return JSONResponse({"ok": True, "artifacts": published})

    async def publish_candidates(live: LiveSession, turn_id: str, run: str) -> JSONResponse:
        """Show an idea's agentic-search candidates and wait for the product decision in-turn."""

        if getattr(live, "active_task_type", "") != ProductTaskType.RESEARCH_IDEA.value:
            raise ValueError("fulltext_authorization_task_required")
        if authorizer is None:
            raise ValueError("fulltext_authorization_unavailable")
        policy = policy_for(RESEARCH_IDEA_FULLTEXT)
        trigger = scoped_relative(run, AGENTIC_METADATA_FILE)
        content = await asyncio.to_thread(policy.read, live.runtime_workdir, trigger)
        if content is None or not content.refs:
            raise ValueError("literature_candidates_unavailable")
        card = await publish_checkpoint_card(live, content, turn_id)
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        challenge, disposition, decision = await authorize_sources(
            live,
            authorizer,
            turn_id=turn_id,
            snapshot_id=live.active_assistant_snapshot_id,
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=content.refs,
        )
        if decision is not None and (
            sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        return JSONResponse(
            {
                "ok": True,
                "card_id": card["card_id"],
                "retained": content.card.retained,
                "status": content.card.status,
                "authorization": {
                    "authorization_type": challenge.authorization_type,
                    "scope_digest": challenge.scope_digest,
                    "sources": [
                        {"id": source.id, "title": source.title} for source in content.sources
                    ],
                    "disposition": disposition.value,
                },
            }
        )

    app.include_router(router)

    @app.post(RESULT_STATUS_ROUTE)
    async def result_status(
        session_id: str, command: ResultStatusRequest, request: Request
    ) -> dict:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session_not_found") from error
        result = await asyncio.to_thread(statuses.resolve, command.papers, command.project_id)
        return {"items": result}

    @app.get("/api/sessions/{session_id}/literature/results/{card_id}")
    async def read_result(session_id: str, card_id: str, request: Request) -> dict:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session_not_found") from error
        if events is None or artifacts is None:
            raise HTTPException(HTTP_404_NOT_FOUND, "literature_result_not_found")
        card = next(
            (
                card
                for card in session_cards(events, session_id, SEARCH_CARD)
                if card.get("card_id") == card_id
            ),
            None,
        )
        if card is None:
            raise HTTPException(HTTP_404_NOT_FOUND, "literature_result_not_found")
        value = dict(card["content"])
        try:
            if value.get("origin") in LITERATURE_REVIEW_ORIGINS:
                snapshots = {}
                for name, field in (
                    (METADATA, "metadata"),
                    (CORPUS, "selection"),
                    (RETRIEVAL, "report"),
                    (FULLTEXT, "fulltext"),
                ):
                    reference = value.get(field)
                    if not isinstance(reference, dict) or not reference.get("artifact_id"):
                        if name == FULLTEXT:
                            continue
                        raise KeyError(field)
                    raw, _ = artifacts.export_bytes(
                        session_id, reference["artifact_id"], reference["sha256"]
                    )
                    snapshots[name] = raw
                papers = project_review_search_artifacts(snapshots)
            elif value.get("origin") == AGENTIC_SEARCH_ORIGIN:
                reference = value["metadata"]
                raw, _ = artifacts.export_bytes(
                    session_id, reference["artifact_id"], reference["sha256"]
                )
                papers = project_agentic_papers(json.loads(raw))
            else:
                reference = value["metadata"]
                raw, _ = artifacts.export_bytes(
                    session_id, reference["artifact_id"], reference["sha256"]
                )
                metadata = json.loads(raw)
                papers = project_papers(metadata["papers"])
                selection_reference = value.get("selection")
                if isinstance(selection_reference, dict) and selection_reference.get("artifact_id"):
                    selection_raw, _ = artifacts.export_bytes(
                        session_id,
                        selection_reference["artifact_id"],
                        selection_reference["sha256"],
                    )
                    selection = json.loads(selection_raw)
                    papers = project_selected_papers(papers, selection, value["run_id"])
            value["papers"] = [paper.model_dump(mode="json") for paper in papers]
        except (ArtifactReadError, ValueError, KeyError, TypeError) as error:
            raise HTTPException(
                HTTP_400_BAD_REQUEST, "literature_result_artifact_unavailable"
            ) from error
        return value

    return router
