"""Publish skill results through the existing active-session card transport."""

from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN, HTTP_404_NOT_FOUND

from service.assistant.service.authorization import (
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
    task_authorization_policy,
)
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.live import LiveSession
from service.chat.service.artifacts import ArtifactReadError, ArtifactService
from service.chat.service.cards import (
    DISPLAY_CARD_CONTINUE_ACTION,
    DISPLAY_CARD_LIMIT_ERRORS,
    DisplayCardError,
    session_cards,
)
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import (
    TASK_ACTIVATION_REQUIRED_ACTION,
    fulltext_binding_workspace,
    verified_authorization_context,
)
from service.identity.utils import request_owner_id
from service.literature.api.gate import FulltextGate, publish_checkpoint_card
from service.literature.persistence.files import scoped_relative
from service.literature.service.agentic import project_agentic_papers
from service.literature.service.checkpoint import agentic_checkpoint, policy_for
from service.literature.service.receipt import issue_receipt
from service.literature.service.result import (
    AGENTIC_SEARCH_ORIGIN,
    ARTIFACT_REFERENCE_FIELDS,
    LITERATURE_REVIEW_ORIGINS,
    SEARCH_CARD,
    SELECTION_NOT_PREPARED,
    AuthorizedFulltext,
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
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.bridge import (
    LITERATURE_RESULT_ROUTE,
    ArtifactPublishFailure,
    DisplayCardContent,
    LiteratureResultPublish,
)
from service.platform.context import FulltextBindingScope, ProductTaskType
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES

RESULT_STATUS_ROUTE = "/api/sessions/{session_id}/literature/result-status"
RESULT_REPORT_ROLE = "supporting"
AGENTIC_CANDIDATES_CHECKPOINT = "candidates"
AGENTIC_METADATA_CHECKPOINT = "metadata"
AGENTIC_METADATA_FILE = "metadata.json"
FINAL_DELIVERY_CHECKPOINT: Literal["final"] = "final"
SELECTION_CHECKPOINT: Literal["selection"] = "selection"
PRECISE_TASK_CHECKPOINTS = frozenset((SELECTION_CHECKPOINT, FINAL_DELIVERY_CHECKPOINT))
FULLTEXT_AUTHORIZATION_TASK_REQUIRED = "fulltext_authorization_task_required"
RESULT_ARTIFACT_INVALID = "literature_result_artifact_invalid"
RESULT_PUBLICATION_FAILED = "literature_result_publication_failed"
SELECTION_PREPARE_ACTION = "prepare and register the confirmed selection before retrying"
RESULT_RETRY_ACTION = "check the search run artifacts and retry"
AUTHORIZED_SOURCE_GUIDANCE = (
    "Only when disposition is authorized, use the exact sources[].ref_id for pdf/read. "
    "If managed full text is not available, use literature/acquire with the same run, "
    "sources[].id as paper_id and the identifier from the published metadata, then retry pdf/read. "
    "Inspect contract/describe for each operation's request schema. "
    "A paper: ref and a literature: catalogue ref are different authorization scopes; "
    "do not substitute a catalogue ref or treat title matches as authorization. "
    "Rejected or interrupted authorization does not permit either acquisition or reading."
)
UNKNOWN_CHECKPOINT = "unknown"

logger = logging.getLogger(__name__)


def register_result_routes(
    app: FastAPI,
    sessions: SessionService,
    catalog: SessionCatalogStore,
    statuses: ResultStatusService,
    events: ProductEventStore | None = None,
    artifacts: ArtifactService | None = None,
    fulltext_gate: FulltextGate | None = None,
    authorizer: FulltextAuthorizer | None = None,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

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
            if command.checkpoint == AGENTIC_METADATA_CHECKPOINT:
                if not command.skill:
                    raise ValueError("plugin_skill_required")
                content = await activities.to_thread(
                    ActivityDomain.BRIDGE,
                    agentic_checkpoint,
                    live.runtime_workdir,
                    scoped_relative(command.run, AGENTIC_METADATA_FILE),
                )
                if (
                    sessions.bridge_caller(live.id) is not live
                    or live.publication_turn_id != turn_id
                ):
                    raise PermissionError("bridge_access_denied")
                card = await publish_checkpoint_card(
                    live, content, turn_id, skill_name=command.skill
                )
                return JSONResponse(
                    {"ok": True, "card_id": card["card_id"], "retained": content.card.retained}
                )
            if command.checkpoint == AGENTIC_CANDIDATES_CHECKPOINT:
                return await publish_candidates(live, turn_id, command.run)
            active_task_type = getattr(live, "active_task_type", "")
            if (
                command.checkpoint in PRECISE_TASK_CHECKPOINTS
                and active_task_type
                and active_task_type != ProductTaskType.PRECISE_SEARCH.value
            ):
                logger.warning(
                    "task_authorization_rejected session_id=%s task_type=precise_search "
                    "validation=active_task_type active_type_matches=False turn_id=%s "
                    "generation=%s lease_revision=%s",
                    live.id,
                    getattr(live, "active_product_turn_id", ""),
                    getattr(live, "product_turn_generation", None),
                    getattr(live, "task_lease_revision", None),
                )
                raise ValueError(FULLTEXT_AUTHORIZATION_TASK_REQUIRED)
            if command.checkpoint == FINAL_DELIVERY_CHECKPOINT:
                return await publish_final_delivery(live, turn_id, command.run)
            task_context = None
            if command.checkpoint == SELECTION_CHECKPOINT:
                task_context = verified_authorization_context(
                    live, ProductTaskType.PRECISE_SEARCH, workspace=command.run
                )
            result_checkpoint: Literal["search", "selection"] = (
                SELECTION_CHECKPOINT if command.checkpoint == SELECTION_CHECKPOINT else "search"
            )
            prepared = await activities.to_thread(
                ActivityDomain.BRIDGE,
                prepare_result,
                live.runtime_workdir,
                command.run,
                result_checkpoint,
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
                if fulltext_gate is None:
                    raise ValueError("fulltext_authorization_unavailable")
                if authorizer is None:
                    raise ValueError("fulltext_authorization_unavailable")
                challenge, disposition, _decision = await fulltext_gate.authorize_sources(
                    live,
                    turn_id=turn_id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    authorization_type=PRECISE_SEARCH_FULLTEXT,
                    refs=prepared.authorization_refs,
                    task_context=task_context,
                    source_count=len(prepared.authorization_sources),
                    papers=tuple(
                        {"id": source.ref_id, "label": source.title, "description": ""}
                        for source in prepared.authorization_sources
                    ),
                )
                authorization = {
                    "authorization_type": challenge.authorization_type,
                    "scope_digest": challenge.scope_digest,
                    "sources": [
                        {"id": source.id, "title": source.title}
                        for source in prepared.authorization_sources
                    ],
                    "disposition": disposition.value,
                    # The subset this turn may actually spend, derived by serve from the
                    # durable decision so the skill never has to guess (or invent) it, and
                    # never wider than what `literature acquire` will allow per ref.
                    "granted_refs": list(
                        authorizer.turn_granted_refs(
                            session_id=live.id,
                            snapshot_id=live.active_assistant_snapshot_id,
                            turn_id=turn_id,
                            authorization_type=PRECISE_SEARCH_FULLTEXT,
                            refs=prepared.authorization_refs,
                            client_turn_id=getattr(live, "active_product_turn_id", ""),
                            task_context=task_context,
                        )
                    ),
                }
        except (ValueError, OSError, DisplayCardError, ArtifactPublishFailure) as error:
            logger.warning(
                "literature_result_publication_failed session_id=%s checkpoint=%s "
                "failure_type=%s failure=%s turn_id=%s publication_turn_id=%s "
                "generation=%s lease_revision=%s",
                live.id,
                checkpoint,
                type(error).__name__,
                str(error)[:200] if isinstance(error, ValueError) else "",
                getattr(live, "active_product_turn_id", ""),
                turn_id,
                getattr(live, "product_turn_generation", None),
                getattr(live, "task_lease_revision", None),
            )
            reason = (
                str(error)
                if isinstance(error, ValueError) and str(error)
                else RESULT_ARTIFACT_INVALID
            )
            action = RESULT_RETRY_ACTION
            if reason in DISPLAY_CARD_LIMIT_ERRORS:
                action = DISPLAY_CARD_CONTINUE_ACTION
            elif reason == SELECTION_NOT_PREPARED:
                action = SELECTION_PREPARE_ACTION
            elif reason == FULLTEXT_AUTHORIZATION_TASK_REQUIRED:
                action = TASK_ACTIVATION_REQUIRED_ACTION
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

        policy = task_authorization_policy(getattr(live, "active_task_type", ""))
        task_context = None
        binding_scope = None
        if policy is None or authorizer is None or getattr(live, "active_task_lease", None) is None:
            # Without a task lease there is no authorization context, so nothing managed can
            # be vouched for; a run that never acquired managed full text still delivers.
            authorized = AuthorizedFulltext()
        else:
            task_context = verified_authorization_context(live, policy.task_type, workspace=run)
            binding_scope = FulltextBindingScope(
                live.id,
                getattr(live, "project_id", "") or "",
                fulltext_binding_workspace(live, policy.task_type),
            )
            receipt = await activities.to_thread(
                ActivityDomain.BRIDGE,
                issue_receipt,
                authorizer,
                run=run,
                session_id=live.id,
                snapshot_id=live.active_assistant_snapshot_id,
                turn_id=live.ledger.active_turn_id,
                authorization_type=policy.authorization_type,
                client_turn_id=getattr(live, "active_product_turn_id", ""),
                task_context=task_context,
                binding_scope=binding_scope,
            )
            authorized = AuthorizedFulltext(
                refs=receipt.refs,
                revisions={paper.paper_id: paper.revision for paper in receipt.papers},
            )
        prepared = await activities.to_thread(
            ActivityDomain.BRIDGE,
            prepare_final_delivery,
            live.runtime_workdir,
            run,
            authorized=authorized,
        )
        published = []
        for artifact in prepared.artifacts:
            if binding_scope is not None and policy is not None:
                if fulltext_binding_workspace(live, policy.task_type) != binding_scope.workspace:
                    raise ValueError(FULLTEXT_AUTHORIZATION_TASK_REQUIRED)
            if task_context is not None and policy is not None:
                if (
                    verified_authorization_context(live, policy.task_type, workspace=run)
                    != task_context
                ):
                    raise ValueError(FULLTEXT_AUTHORIZATION_TASK_REQUIRED)
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
        if fulltext_gate is None:
            raise ValueError("fulltext_authorization_unavailable")
        policy = policy_for(RESEARCH_IDEA_FULLTEXT)
        trigger = scoped_relative(run, AGENTIC_METADATA_FILE)
        content = await activities.to_thread(
            ActivityDomain.BRIDGE, policy.read, live.runtime_workdir, trigger
        )
        if content is None or not content.refs:
            raise ValueError("literature_candidates_unavailable")
        card = await publish_checkpoint_card(live, content, turn_id)
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        challenge, disposition, _decision = await fulltext_gate.authorize_sources(
            live,
            turn_id=turn_id,
            snapshot_id=live.active_assistant_snapshot_id,
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=content.refs,
            papers=tuple(
                {"id": source.ref_id, "label": source.title} for source in content.sources
            ),
            source_count=len(content.sources),
        )
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
                        {"id": source.id, "ref_id": source.ref_id, "title": source.title}
                        for source in content.sources
                    ],
                    "disposition": disposition.value,
                    "guidance": AUTHORIZED_SOURCE_GUIDANCE,
                },
            }
        )

    app.include_router(router)

    async def admit_read():
        try:
            activity = activities.enter(ActivityDomain.LITERATURE, root=True)
        except MaintenanceActive as error:
            raise HTTPException(503, "update_maintenance") from error
        with activity:
            yield

    read_admission = [Depends(admit_read)]

    @app.post(RESULT_STATUS_ROUTE, dependencies=read_admission)
    async def result_status(
        session_id: str, command: ResultStatusRequest, request: Request
    ) -> dict:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session_not_found") from error
        result = await activities.to_thread(
            ActivityDomain.BRIDGE, statuses.resolve, command.papers, command.project_id
        )
        return {"items": result}

    @app.get("/api/sessions/{session_id}/literature/results/{card_id}", dependencies=read_admission)
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
                papers = project_agentic_papers(json.loads(raw), complete=True)
            else:
                reference = value["metadata"]
                raw, _ = artifacts.export_bytes(
                    session_id, reference["artifact_id"], reference["sha256"]
                )
                metadata = json.loads(raw)
                papers = project_papers(metadata["papers"], complete=True)
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
