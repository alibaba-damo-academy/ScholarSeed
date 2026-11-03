"""Publish survey evidence through the authorized conversation bridge."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
)
from service.capabilities.service.plugins import PLUGIN_OUTLINE_SLOT
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.cards import DisplayCardError
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import (
    TASK_ACTIVATION_REQUIRED_ACTION,
    verified_authorization_context,
)
from service.literature.api.gate import FulltextGate
from service.literature.persistence.files import scoped_workspace, scoped_workspace_path
from service.literature.service.confirmation import (
    OUTLINE_CHECKPOINT,
    REVIEW_NEXT_ACTION,
    confirmation_continuation,
    prepare_confirmation,
)
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
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_REVIEW_ROUTE,
    ArtifactPublishFailure,
    DisplayCardContent,
    LiteratureReviewPublish,
)
from service.platform.context import ProductTaskType
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES

RETRIEVAL_REFERENCE_ROLE = "supporting"
REVIEW_WORKSPACE_MISMATCH = "review_workspace_mismatch"
REVIEW_ARTIFACT_MISSING = "review_artifact_missing"
REVIEW_TASK_MISSING = "task_context_missing"
REVIEW_TASK_BLOCKED_ACTIONS = {
    "task_context_mismatch": (
        "Stop this checkpoint: the active task does not match the requested review run. "
        "Verify the intended task and its original workspace/binding before activating it."
    ),
    "task_context_stale": "Stop this checkpoint: resume the intended task in a new active turn.",
}
REVIEW_WORKSPACE_ACTION = (
    "Use the exact session-workdir-relative workspace returned by successful task activation."
)
REVIEW_ARTIFACT_ACTION = "Inspect and repair the named review workspace artifacts before retrying."
REVIEW_RETRY_ACTION = (
    " Do not retry the same failed request while inputs and state are unchanged; "
    "perform next_action first."
)

logger = logging.getLogger(__name__)


def register_literature_review_routes(
    app: FastAPI,
    sessions: SessionService,
    fulltext_gate: FulltextGate | None = None,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

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
            workspace = scoped_workspace(command.workspace)
            prepared: PreparedReview | PreparedReviewSearch
            retrieval_prepared: PreparedReviewSearch | None = None
            run_id: str | None = None
            if command.checkpoint == "retrieval":
                lease = getattr(live, "active_task_lease", None)
                if lease is None:
                    raise ValueError(REVIEW_TASK_MISSING)
                if lease.task_type is not ProductTaskType.LITERATURE_REVIEW:
                    raise ValueError("task_context_mismatch")
                if lease.workspace != workspace:
                    raise ValueError(REVIEW_WORKSPACE_MISMATCH)
                expected_hashes: dict[str, str] = {}
                if command.manifest or command.manifest_sha256:
                    # A launcher manifest pins the exact artifacts it announced.
                    if not command.run_id or not command.manifest or not command.manifest_sha256:
                        raise ValueError("review_checkpoint_manifest_required")
                    expected_hashes = await activities.to_thread(
                        ActivityDomain.BRIDGE,
                        validate_review_checkpoint,
                        live.runtime_workdir,
                        workspace,
                        command.run_id,
                        command.manifest,
                        command.manifest_sha256,
                    )
                    run_id = command.run_id
                else:
                    run_id = await activities.to_thread(
                        ActivityDomain.BRIDGE, review_retrieval_run, live.runtime_workdir, workspace
                    )
                if not lease.matches_run(
                    task_type=ProductTaskType.LITERATURE_REVIEW,
                    workspace=workspace,
                    run_id=run_id,
                ):
                    raise ValueError("task_context_mismatch")
                prepared = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    prepare_review_search,
                    live.runtime_workdir,
                    workspace,
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
                prepared = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    prepare_review,
                    live.runtime_workdir,
                    workspace,
                    command.checkpoint,
                )
            if command.checkpoint == "retrieval":
                references = []
                card_sources = {
                    scoped_workspace_path(workspace, name)
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
            outline_confirmation = (
                await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    prepare_confirmation,
                    live.runtime_workdir,
                    workspace,
                    live.id,
                    turn_id,
                )
                if checkpoint == OUTLINE_CHECKPOINT
                else None
            )
            content = prepared.card.model_copy(update=update).model_dump(mode="json")
            card = await live.display_card(
                card_type, DisplayCardContent(data=content), turn_id=turn_id
            )
            authorization = None
            confirmation = None
            if outline_confirmation is not None and outline_confirmation.question is not None:
                reference = await live.component_for(
                    PLUGIN_OUTLINE_SLOT, interaction_id=str(outline_confirmation.question["id"])
                )
                if reference is not None:
                    outline_confirmation.question["component"] = reference
                    outline_confirmation.question["component_data"] = content
                with activities.enter(ActivityDomain.BRIDGE) as activity:
                    decision = await live.interactions.request_product_input(
                        outline_confirmation.question,
                        turn_id=turn_id,
                        timeout_seconds=outline_confirmation.timeout_seconds,
                        activity=activity,
                    )
                require_turn()
                current = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    prepare_confirmation,
                    live.runtime_workdir,
                    workspace,
                    live.id,
                    turn_id,
                )
                if current.digest != outline_confirmation.digest:
                    raise ValueError("review_packet_changed")
                request_id = str(outline_confirmation.question["id"])
                record = live.catalog.hil(request_id)
                confirmation = {
                    "packet_id": outline_confirmation.packet_id,
                    "snapshot_id": outline_confirmation.snapshot_id,
                    "request_id": request_id,
                    "started_at": record.created_at,
                    "deadline_at": (
                        record.created_at + outline_confirmation.timeout_seconds
                        if outline_confirmation.timeout_seconds
                        else None
                    ),
                    "decision": decision,
                }
            if retrieval_prepared is not None and retrieval_prepared.authorization_refs:
                assert run_id is not None
                if fulltext_gate is None:
                    raise ValueError("fulltext_authorization_unavailable")
                challenge, disposition, _decision = await fulltext_gate.authorize_sources(
                    live,
                    turn_id=turn_id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    authorization_type=LITERATURE_REVIEW_FULLTEXT,
                    refs=retrieval_prepared.authorization_refs,
                    papers=tuple(
                        {"id": source.ref_id, "label": source.title}
                        for source in retrieval_prepared.authorization_sources
                    ),
                    task_context=verified_authorization_context(
                        live, ProductTaskType.LITERATURE_REVIEW, workspace=workspace, run_id=run_id
                    ),
                    source_count=len(retrieval_prepared.authorization_sources),
                )
                authorization = {
                    "disposition": disposition.value,
                    "authorization_type": challenge.authorization_type,
                    "scope_digest": challenge.scope_digest,
                    "sources": [
                        {"id": source.id, "title": source.title}
                        for source in retrieval_prepared.authorization_sources
                    ],
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
                REVIEW_ARTIFACT_MISSING
                if isinstance(error, FileNotFoundError)
                else (
                    str(error)
                    if isinstance(error, ValueError) and str(error)
                    else "review_artifact_invalid"
                )
            )
            action = (
                TASK_ACTIVATION_REQUIRED_ACTION
                if reason == REVIEW_TASK_MISSING
                else REVIEW_TASK_BLOCKED_ACTIONS.get(
                    reason,
                    (
                        REVIEW_WORKSPACE_ACTION
                        if reason == REVIEW_WORKSPACE_MISMATCH
                        else REVIEW_ARTIFACT_ACTION
                    ),
                )
                + REVIEW_RETRY_ACTION
            )
            return JSONResponse(
                {
                    "ok": False,
                    "error": "review_publication_failed",
                    "reason": reason,
                    "recoverable": reason not in REVIEW_TASK_BLOCKED_ACTIONS,
                    "action": action,
                    "next_action": action,
                },
                HTTP_400_BAD_REQUEST,
            )
        return JSONResponse(
            {
                "ok": True,
                "card_id": card["card_id"],
                "status": prepared.card.status,
                **({"authorization": authorization} if authorization is not None else {}),
                **(
                    {
                        "confirmation": confirmation,
                        "continuation": confirmation_continuation(confirmation),
                        "next_action": REVIEW_NEXT_ACTION,
                    }
                    if confirmation is not None
                    else {}
                ),
            }
        )

    app.include_router(router)
    return router
