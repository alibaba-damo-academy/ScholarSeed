"""Publish skill results through the existing active-session card transport."""

from __future__ import annotations

import json
import logging
from hashlib import sha256
from typing import Any, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
)

from service.assistant.service.authorization import (
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
    task_authorization_policy,
)
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.constants import (
    PRODUCT_DECISION_SOURCE,
    PRODUCT_DECISION_USER,
    PRODUCT_INTERACTION_MANUAL,
)
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
from service.literature.service.cited import (
    CITATIONS_CHECKPOINT,
    CITATIONS_ORIGIN,
    prepare_citations,
    project_citations,
)
from service.literature.service.holdings import (
    HELD_UNSUPPORTED,
    HeldAttachmentRequest,
    HoldingsRequest,
    admit_held_fulltexts,
    session_holdings,
)
from service.literature.service.receipt import issue_receipt
from service.literature.service.result import (
    AGENTIC_SEARCH_ORIGIN,
    ARTIFACT_REFERENCE_FIELDS,
    LITERATURE_REVIEW_ORIGINS,
    PRECISE_SEARCH_ORIGIN,
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
    CONFIRM_SEARCH_START_ROUTE,
    LITERATURE_RESULT_ROUTE,
    ArtifactPublishFailure,
    DisplayCardContent,
    LiteratureResultPublish,
    LiteratureSearchStart,
    LiteratureSearchStartResult,
)
from service.platform.citations import PDF_INDEX_STATE
from service.platform.context import FulltextBindingScope, ProductTaskType

RESULT_STATUS_ROUTE = "/api/sessions/{session_id}/literature/result-status"
FULLTEXT_HOLDINGS_ROUTE = (
    "/api/sessions/{session_id}/literature/results/{card_id}/fulltext-holdings"
)
HELD_ATTACHMENTS_ROUTE = "/api/sessions/{session_id}/literature/results/{card_id}/attachments/held"
RESULT_NOT_FOUND = "literature_result_not_found"
SEARCH_START_PRESENTATION = "precise-search-start"
SEARCH_START: Literal["start"] = "start"
SEARCH_DEFER: Literal["defer"] = "defer"
SESSION_WORKDIR_UNAVAILABLE = "literature_session_workdir_unavailable"
RESULT_REPORT_ROLE = "supporting"
AGENTIC_CANDIDATES_CHECKPOINT = "candidates"
AGENTIC_METADATA_CHECKPOINT = "metadata"
AGENTIC_METADATA_FILE = "metadata.json"
FINAL_DELIVERY_CHECKPOINT: Literal["final"] = "final"
SELECTION_CHECKPOINT: Literal["selection"] = "selection"
PRECISE_TASK_CHECKPOINTS = frozenset((SELECTION_CHECKPOINT, FINAL_DELIVERY_CHECKPOINT))
FULLTEXT_AUTHORIZATION_TASK_REQUIRED = "fulltext_authorization_task_required"


class ReauthorizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assistant_context_revision: int = Field(ge=0, strict=True)


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


def search_card_content(
    events: ProductEventStore | None, session_id: str, card_id: str
) -> dict[str, Any]:
    """One published literature-search card's content, exactly as the product stored it."""
    if events is None:
        raise ValueError(RESULT_NOT_FOUND)
    card = next(
        (
            card
            for card in session_cards(events, session_id, SEARCH_CARD)
            if card.get("card_id") == card_id
        ),
        None,
    )
    if card is None:
        raise ValueError(RESULT_NOT_FOUND)
    return dict(card["content"])


def request_pdf_indexes(request: Request) -> Any:
    """The process-wide full-text index port, when this deployment wires one."""
    return getattr(request.app.state, PDF_INDEX_STATE, None)


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

    @router.post(CONFIRM_SEARCH_START_ROUTE)
    async def confirm_search_start(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not (turn_id := live.publication_turn_id):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            LiteratureSearchStart.model_validate_json(await request.body())
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "invalid_search_start_request"}, HTTP_400_BAD_REQUEST
            )
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        identity = sha256(json.dumps([live.id, turn_id]).encode()).hexdigest()
        request_id = f"{SEARCH_START_PRESENTATION}:{identity}"
        decision = await live.interactions.request_product_input(
            {
                "id": request_id,
                "header": "Confirm literature search",
                "question": "Start the literature search?",
                "options": [{"label": action} for action in (SEARCH_START, SEARCH_DEFER)],
                "presentation": {"kind": SEARCH_START_PRESENTATION},
                PRODUCT_INTERACTION_MANUAL: True,
            },
            turn_id=turn_id,
            activity=live.bridge_activity,
        )
        start = (
            sessions.bridge_caller(live.id) is live
            and live.publication_turn_id == turn_id
            and decision.get(PRODUCT_DECISION_SOURCE) == PRODUCT_DECISION_USER
            and not decision.get("cancelled")
            and not decision.get("timed_out")
            and not decision.get("free_text")
            and decision.get("answers") == {request_id: SEARCH_START}
        )
        result = LiteratureSearchStartResult(
            ok=True, disposition=SEARCH_START if start else SEARCH_DEFER
        )
        return JSONResponse(result.model_dump())

    @router.post(LITERATURE_RESULT_ROUTE)
    async def publish_result(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        checkpoint = UNKNOWN_CHECKPOINT
        raw = await request.body()
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
            if command.checkpoint == CITATIONS_CHECKPOINT:
                prepared = await activities.to_thread(
                    ActivityDomain.BRIDGE, prepare_citations, live.runtime_workdir, command.run
                )
            else:
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
            resultContent = prepared.card.model_copy(
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
                SEARCH_CARD, DisplayCardContent(data=resultContent), turn_id=turn_id
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
                    result_card_id=str(card["card_id"]),
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
            source_count=len(content.sources),
            papers=tuple(
                {"id": source.ref_id, "label": source.title, "description": ""}
                for source in content.sources
            ),
            result_card_id=str(card["card_id"]),
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

    @app.post(
        "/api/sessions/{session_id}/literature/authorizations/{question_id}/retry",
        dependencies=read_admission,
    )
    async def retry_authorization(
        session_id: str, question_id: str, command: ReauthorizationRequest, request: Request
    ) -> dict:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session_not_found") from error
        record = catalog.get(session_id)
        if record is None or record.archived or sessions.is_readonly(session_id):
            raise HTTPException(HTTP_409_CONFLICT, "session_readonly")
        live = sessions.interaction_session(session_id)
        if live is None or fulltext_gate is None:
            raise HTTPException(HTTP_409_CONFLICT, "session_not_live")
        try:
            return await fulltext_gate.retry(
                live, question_id, context_revision=command.assistant_context_revision
            )
        except (ValueError, SessionAccessError) as error:
            raise HTTPException(HTTP_409_CONFLICT, str(error)) from error

    @app.get(
        "/api/sessions/{session_id}/literature/authorizations/{question_id}/retry",
        dependencies=read_admission,
    )
    async def retry_authorization_status(
        session_id: str, question_id: str, request: Request
    ) -> dict:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
            if authorizer is None:
                raise ValueError("fulltext_authorization_unavailable")
            renewed = authorizer.renewal(session_id, question_id)
        except (ValueError, SessionAccessError) as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "fulltext_reauthorization_not_found") from error
        return {"ok": True, "request_id": renewed.question_id}

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

    def precise_card_run(
        session_id: str, card_id: str, request: Request
    ) -> tuple[dict[str, Any], str]:
        """Resolve one published precise-search card and the workdir holding its run.

        只有精确检索卡片能走「元信息和全文」: 别的结果卡片既没有产品托管的字节, 也没有
        技能自己下载的 run 目录 PDF 可复用, 所以这里直接拒绝, 界面也不会给出这个选项。
        """
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session_not_found") from error
        try:
            content = search_card_content(events, session_id, card_id)
        except ValueError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, str(error)) from error
        if content.get("origin") != PRECISE_SEARCH_ORIGIN:
            raise HTTPException(HTTP_400_BAD_REQUEST, HELD_UNSUPPORTED)
        record = catalog.get(session_id)
        workdir = record.runtime_workdir_path if record is not None else None
        if workdir is None:
            raise HTTPException(HTTP_409_CONFLICT, SESSION_WORKDIR_UNAVAILABLE)
        return content, workdir

    @app.post(FULLTEXT_HOLDINGS_ROUTE, dependencies=read_admission)
    async def fulltext_holdings(
        session_id: str, card_id: str, command: HoldingsRequest, request: Request
    ) -> dict:
        """Which selected papers already have full-text bytes the product can reuse."""
        card, workdir = precise_card_run(session_id, card_id, request)
        held = await activities.to_thread(
            ActivityDomain.LITERATURE,
            session_holdings,
            workdir,
            session_id,
            str(card.get("run_id") or ""),
            [paper.id for paper in command.papers],
        )
        return {
            "items": {
                paper_id: {"storage": holding.storage, "name": holding.name}
                for paper_id, holding in held.items()
            }
        }

    @app.post(HELD_ATTACHMENTS_ROUTE, dependencies=read_admission)
    async def attach_held_fulltexts(
        session_id: str, card_id: str, command: HeldAttachmentRequest, request: Request
    ) -> dict:
        """Admit already-downloaded PDFs into the library; never download them again."""
        card, workdir = precise_card_run(session_id, card_id, request)
        outcomes = await activities.to_thread(
            ActivityDomain.LITERATURE,
            admit_held_fulltexts,
            workdir,
            session_id,
            str(card.get("run_id") or ""),
            command.papers,
            pdf_indexes=request_pdf_indexes(request),
        )
        items = [outcome.payload() for outcome in outcomes]
        return {
            "items": items,
            "acquired": sum(item["attached"] for item in items),
            "fulltext": sum(item["fulltext"] for item in items),
            "failed": sum(1 for item in items if not item["fulltext"]),
        }

    @app.get("/api/sessions/{session_id}/literature/results/{card_id}", dependencies=read_admission)
    async def read_result(session_id: str, card_id: str, request: Request) -> dict:
        try:
            catalog.require(session_id, SessionPrincipal(request_owner_id(request)))
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session_not_found") from error
        if artifacts is None:
            raise HTTPException(HTTP_404_NOT_FOUND, RESULT_NOT_FOUND)
        try:
            value = search_card_content(events, session_id, card_id)
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
            elif value.get("origin") == CITATIONS_ORIGIN:
                reference = value["metadata"]
                raw, _ = artifacts.export_bytes(
                    session_id, reference["artifact_id"], reference["sha256"]
                )
                papers = project_citations(json.loads(raw), complete=True)
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
            if str(error) == RESULT_NOT_FOUND:
                raise HTTPException(HTTP_404_NOT_FOUND, RESULT_NOT_FOUND) from error
            raise HTTPException(
                HTTP_400_BAD_REQUEST, "literature_result_artifact_unavailable"
            ) from error
        return value

    return router
