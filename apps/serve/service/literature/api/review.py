"""Publish survey evidence through the authorized conversation bridge."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
    FulltextAuthorizer,
)
from service.chat.api.bridge import bridge_caller
from service.chat.service.cards import DisplayCardError
from service.chat.service.sessions import SessionService
from service.literature.api.gate import authorize_sources
from service.literature.persistence.files import scoped_relative
from service.literature.service.result import ARTIFACT_REFERENCE_FIELDS, SEARCH_CARD
from service.literature.service.review import (
    CORPUS,
    FULLTEXT,
    METADATA,
    RETRIEVAL,
    REVIEW_CARD,
    PreparedReview,
    PreparedReviewSearch,
    prepare_review,
    prepare_review_search,
    review_retrieval_run,
    validate_review_checkpoint,
)
from service.platform.bridge import (
    BRIDGE_MAX_REQUEST_BYTES,
    LITERATURE_REVIEW_ROUTE,
    ArtifactPublishFailure,
    DisplayCardContent,
    LiteratureReviewPublish,
)
from service.platform.context import ProductTaskType

RETRIEVAL_REFERENCE_ROLE = "supporting"

logger = logging.getLogger(__name__)


def register_literature_review_routes(
    app: FastAPI,
    sessions: SessionService,
    authorizer: FulltextAuthorizer | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post(LITERATURE_REVIEW_ROUTE)
    async def publish_review(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id

        def require_turn() -> None:
            if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
                raise PermissionError("bridge_access_denied")

        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "bridge_request_too_large"}, HTTP_400_BAD_REQUEST
                )
        checkpoint = ""
        try:
            command = LiteratureReviewPublish.model_validate(json.loads(raw))
            checkpoint = command.checkpoint
            prepared: PreparedReview | PreparedReviewSearch
            retrieval_prepared: PreparedReviewSearch | None = None
            if command.checkpoint == "retrieval":
                expected_hashes: dict[str, str] = {}
                if command.manifest or command.manifest_sha256:
                    # A launcher manifest pins the exact artifacts it announced.
                    if not command.run_id or not command.manifest or not command.manifest_sha256:
                        raise ValueError("review_checkpoint_manifest_required")
                    expected_hashes = await asyncio.to_thread(
                        validate_review_checkpoint,
                        live.runtime_workdir,
                        command.workspace,
                        command.run_id,
                        command.manifest,
                        command.manifest_sha256,
                    )
                    run_id = command.run_id
                else:
                    run_id = await asyncio.to_thread(
                        review_retrieval_run, live.runtime_workdir, command.workspace
                    )
                    if command.run_id and command.run_id != run_id:
                        raise ValueError("review_checkpoint_identity_invalid")
                lease = getattr(live, "active_task_lease", None)
                if lease is None:
                    raise ValueError("task_context_missing")
                if not lease.matches_run(
                    task_type=ProductTaskType.LITERATURE_REVIEW,
                    workspace=scoped_relative(command.workspace),
                    run_id=run_id,
                ):
                    raise ValueError("task_context_mismatch")
                prepared = await asyncio.to_thread(
                    prepare_review_search,
                    live.runtime_workdir,
                    command.workspace,
                    run_id,
                )
                retrieval_prepared = prepared
                if any(
                    expected_hashes.get(source.path) != source.digest
                    for source in prepared.files
                    if source.path in expected_hashes
                ):
                    raise ValueError("review_checkpoint_artifact_changed")
            else:
                prepared = await asyncio.to_thread(
                    prepare_review,
                    live.runtime_workdir,
                    command.workspace,
                    command.checkpoint,
                )
            if command.checkpoint == "retrieval":
                references = []
                card_sources = {
                    scoped_relative(command.workspace, name)
                    for name in (METADATA, CORPUS, RETRIEVAL, FULLTEXT)
                }
                for source in prepared.files:
                    if source.path not in card_sources:
                        continue
                    require_turn()
                    published_artifact = await live.publish_artifact(
                        source.path,
                        RETRIEVAL_REFERENCE_ROLE,
                        turn_id=turn_id,
                        expected_sha256=source.digest,
                    )
                    require_turn()
                    references.append(
                        {
                            **{
                                key: published_artifact.get(key)
                                for key in ARTIFACT_REFERENCE_FIELDS
                            },
                            "title": source.title,
                        }
                    )

                def find_artifact(name: str) -> dict:
                    for reference in references:
                        path = reference.get("path")
                        if isinstance(path, str) and (path == name or path.endswith(f"/{name}")):
                            return reference
                    return {}

                update = {
                    "session_id": live.id,
                    "metadata": find_artifact(METADATA),
                    "selection": find_artifact(CORPUS),
                    "report": find_artifact(RETRIEVAL),
                    "fulltext": find_artifact(FULLTEXT),
                }
                card_type = SEARCH_CARD
            else:
                update = {"session_id": live.id}
                card_type = REVIEW_CARD
            require_turn()
            content = prepared.card.model_copy(update=update).model_dump(mode="json")
            card = await live.display_card(
                card_type, DisplayCardContent(data=content), turn_id=turn_id
            )
            authorization = None
            if retrieval_prepared is not None and retrieval_prepared.authorization_refs:
                if authorizer is None:
                    raise ValueError("fulltext_authorization_unavailable")
                challenge, disposition, decision = await authorize_sources(
                    live,
                    authorizer,
                    turn_id=turn_id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    authorization_type=LITERATURE_REVIEW_FULLTEXT,
                    refs=retrieval_prepared.authorization_refs,
                )
                if decision is not None:
                    require_turn()
                authorization = {
                    "authorization_type": challenge.authorization_type,
                    "scope_digest": challenge.scope_digest,
                    "sources": [
                        {"id": source.id, "title": source.title}
                        for source in retrieval_prepared.authorization_sources
                    ],
                    "disposition": disposition.value,
                }
        except PermissionError:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        except (ValueError, OSError, DisplayCardError, ArtifactPublishFailure) as error:
            logger.warning(
                "literature_review_publication_failed session_id=%s checkpoint=%s "
                "failure_type=%s failure=%s",
                live.id,
                checkpoint,
                type(error).__name__,
                str(error)[:200] if isinstance(error, ValueError) else "",
            )
            reason = (
                str(error)
                if isinstance(error, ValueError) and str(error)
                else "review_artifact_invalid"
            )
            return JSONResponse(
                {
                    "ok": False,
                    "error": "review_publication_failed",
                    "reason": reason,
                    "recoverable": reason not in {"task_context_mismatch", "task_context_stale"},
                    "action": (
                        "re-run the bound workspace launcher in the active turn"
                        if reason.startswith("task_context_")
                        else "check the review workspace artifacts and retry"
                    ),
                },
                HTTP_400_BAD_REQUEST,
            )
        return JSONResponse(
            {
                "ok": True,
                "card_id": card["card_id"],
                "status": prepared.card.status,
                **({"authorization": authorization} if authorization is not None else {}),
            }
        )

    app.include_router(router)
    return router
