"""Publish survey evidence through the authorized conversation bridge."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
    AuthorizationDisposition,
)
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.cards import DisplayCardError
from service.chat.service.handoffs import OUTLINE_RECEIPT, PLAN_RECEIPT, publish_receipt
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import (
    TASK_ACTIVATION_REQUIRED_ACTION,
    verified_authorization_context,
)
from service.literature.api.gate import FulltextGate
from service.literature.persistence.files import (
    read_scoped_file,
    scoped_workspace,
    scoped_workspace_path,
)
from service.literature.service.confirmation import (
    OUTLINE_CHECKPOINT,
    PLAN_CHECKPOINT,
    PLAN_NEXT_ACTION,
    REVIEW_NEXT_ACTION,
    await_confirmation,
    confirmation_continuation,
    prepare_confirmation,
)
from service.literature.service.result import (
    ARTIFACT_REFERENCE_FIELDS,
    SEARCH_CARD,
    FulltextApplicability,
)
from service.literature.service.reuse import ReadingReuse
from service.literature.service.review import (
    CORPUS,
    FULLTEXT,
    METADATA,
    RETRIEVAL,
    REVIEW_CARD,
    PreparedReview,
    PreparedReviewSearch,
    ReviewMetadataError,
    prepare_review,
    prepare_review_search,
    review_retrieval_run,
    review_workspace_run,
    validate_review_checkpoint,
)
from service.literature.service.selected import SELECTED_MAX_BYTES
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_REVIEW_ROUTE,
    ArtifactPublishFailure,
    DisplayCardContent,
    LiteratureReviewPublish,
)
from service.platform.context import ProductTaskType

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
    reading_reuse: ReadingReuse | None = None,
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

        raw = await request.body()
        checkpoint = ""
        try:
            command = LiteratureReviewPublish.model_validate(json.loads(raw))
            checkpoint = command.checkpoint
            workspace = scoped_workspace(command.workspace)
            if checkpoint == PLAN_CHECKPOINT:
                lease = getattr(live, "active_task_lease", None)
                if lease is None:
                    raise ValueError(REVIEW_TASK_MISSING)
                plan_run_id = await activities.to_thread(
                    ActivityDomain.BRIDGE, review_workspace_run, live.runtime_workdir, workspace
                )
                plan_context = verified_authorization_context(
                    live, ProductTaskType.LITERATURE_REVIEW, workspace=workspace, run_id=plan_run_id
                )
                prepared_plan = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    prepare_confirmation,
                    live.runtime_workdir,
                    workspace,
                    live.id,
                    turn_id,
                    PLAN_CHECKPOINT,
                )
                require_turn()
                confirmation = await await_confirmation(
                    live, activities, prepared_plan, workspace, turn_id, PLAN_CHECKPOINT
                )
                require_turn()
                if (
                    verified_authorization_context(
                        live,
                        ProductTaskType.LITERATURE_REVIEW,
                        workspace=workspace,
                        run_id=plan_run_id,
                    )
                    != plan_context
                ):
                    raise ValueError("task_context_stale")
                response = {
                    "ok": True,
                    "confirmation": confirmation,
                    "next_action": (
                        PLAN_NEXT_ACTION
                        if confirmation is not None
                        else "The current execution plan already has a decision. Continue without another confirmation."
                    ),
                }
                if confirmation is not None:
                    response["receipt_ref"] = await activities.to_thread(
                        ActivityDomain.BRIDGE,
                        publish_receipt,
                        live.runtime_workdir,
                        workspace,
                        plan_run_id,
                        PLAN_RECEIPT,
                        dict(response),
                    )
                    require_turn()
                return JSONResponse(response)
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

                update: dict[str, object] = {
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
            task_request = {}
            if retrieval_prepared is not None:
                try:
                    task_request = json.loads(
                        read_scoped_file(
                            live.runtime_workdir,
                            scoped_workspace_path(workspace, "01_input/writing_request.json"),
                            SELECTED_MAX_BYTES,
                        )
                    )
                except FileNotFoundError:
                    pass  # Existing Standard workspaces can predate writing_request.json.
            abstract_only = task_request.get("execution", {}).get("mode") == "quick"
            if retrieval_prepared is not None and abstract_only:
                update["fulltext_authorization"] = FulltextApplicability()
            content = prepared.card.model_copy(update=update).model_dump(mode="json")
            card = await live.display_card(
                card_type, DisplayCardContent(data=content), turn_id=turn_id
            )
            authorization: dict[str, Any] | None = None
            reading_assets = None
            confirmation = None
            if outline_confirmation is not None and outline_confirmation.question is not None:
                confirmation = await await_confirmation(
                    live, activities, outline_confirmation, workspace, turn_id, OUTLINE_CHECKPOINT
                )
                require_turn()
            if retrieval_prepared is not None and abstract_only:
                authorization = {
                    "disposition": "not_required",
                    "evidence_kind": "abstract",
                    "granted_refs": [],
                }
            if (
                retrieval_prepared is not None
                and retrieval_prepared.authorization_refs
                and not abstract_only
            ):
                assert run_id is not None
                if fulltext_gate is None:
                    raise ValueError("fulltext_authorization_unavailable")
                challenge, disposition, _decision = await fulltext_gate.authorize_sources(
                    live,
                    turn_id=turn_id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    authorization_type=LITERATURE_REVIEW_FULLTEXT,
                    refs=retrieval_prepared.authorization_refs,
                    task_context=verified_authorization_context(
                        live, ProductTaskType.LITERATURE_REVIEW, workspace=workspace, run_id=run_id
                    ),
                    source_count=len(retrieval_prepared.authorization_sources),
                    papers=tuple(
                        {"id": source.ref_id, "label": source.title, "description": ""}
                        for source in retrieval_prepared.authorization_sources
                    ),
                    result_card_id=str(card["card_id"]),
                )
                require_turn()
                context = verified_authorization_context(
                    live, ProductTaskType.LITERATURE_REVIEW, workspace=workspace, run_id=run_id
                )
                granted_refs = fulltext_gate.granted_refs(
                    live,
                    turn_id=turn_id,
                    authorization_type=LITERATURE_REVIEW_FULLTEXT,
                    refs=retrieval_prepared.authorization_refs,
                    task_context=context,
                )
                authorization = {
                    "disposition": disposition.value,
                    "granted_refs": list(granted_refs),
                    "authorization_type": challenge.authorization_type,
                    "scope_digest": challenge.scope_digest,
                    "sources": [
                        {"id": source.id, "title": source.title}
                        for source in retrieval_prepared.authorization_sources
                    ],
                }
            if (
                retrieval_prepared is not None
                and reading_reuse is not None
                and task_request.get("execution", {}).get("mode") != "quick"
                and authorization is not None
                and authorization["disposition"] == AuthorizationDisposition.AUTHORIZED.value
                and set(retrieval_prepared.authorization_refs) <= set(authorization["granted_refs"])
            ):
                require_turn()
                verified_authorization_context(
                    live, ProductTaskType.LITERATURE_REVIEW, workspace=workspace, run_id=run_id
                )
                bundle = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    reading_reuse.prepare,
                    live.runtime_workdir,
                    workspace,
                    retrieval_prepared.corpus_sha256,
                    run_id,
                )
                require_turn()
                verified_authorization_context(
                    live, ProductTaskType.LITERATURE_REVIEW, workspace=workspace, run_id=run_id
                )
                reading_assets = reading_reuse.publish(live.runtime_workdir, workspace, bundle)
            response = {
                "ok": True,
                "card_id": card["card_id"],
                **({"reading_assets": reading_assets} if reading_assets is not None else {}),
                "status": prepared.card.status,
                **({"authorization": authorization} if authorization is not None else {}),
            }
            if confirmation is not None:
                response.update(confirmation=confirmation, next_action=REVIEW_NEXT_ACTION)
                outline_run_id = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    review_workspace_run,
                    live.runtime_workdir,
                    workspace,
                )
                require_turn()
                reference = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    publish_receipt,
                    live.runtime_workdir,
                    workspace,
                    outline_run_id,
                    OUTLINE_RECEIPT,
                    dict(response),
                )
                require_turn()
                response.update(
                    receipt_ref=reference,
                    continuation=confirmation_continuation(confirmation, reference),
                )
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
            if isinstance(error, ReviewMetadataError):
                action = (
                    "Repair the listed fields in the named artifact using source candidate metadata. "
                    "Keep the selected papers, local source references and citation mappings; "
                    "do not repeat discovery or reread full text for an identifier/type error. "
                    "Then retry this checkpoint."
                )
            return JSONResponse(
                {
                    "ok": False,
                    "error": "review_publication_failed",
                    "reason": reason,
                    "recoverable": reason not in REVIEW_TASK_BLOCKED_ACTIONS,
                    "action": action,
                    "next_action": action,
                    **({"issues": error.issues} if isinstance(error, ReviewMetadataError) else {}),
                },
                HTTP_400_BAD_REQUEST,
            )
        return JSONResponse(response)

    app.include_router(router)
    return router
