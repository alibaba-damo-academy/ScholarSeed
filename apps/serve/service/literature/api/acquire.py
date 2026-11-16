"""Bridge route for authorized full-text acquisition (proposal 116 G1 PEP)."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.assistant.service.authorization import (
    FulltextAuthorizer,
    fulltext_binding_scope,
    task_authorization_policy,
)
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import (
    TASK_ACTIVATION_REQUIRED_ACTION,
    fulltext_binding_workspace,
    verified_authorization_context,
)
from service.literature.domain.delivery import AcquisitionScope
from service.literature.persistence.files import scoped_relative
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts
from service.literature.service.arxiv import normalize_arxiv_id
from service.literature.service.fulltext import normalize_doi
from service.literature.service.fulltexts import PAPER_REF_PREFIX
from service.literature.service.scope import (
    DOWNLOAD_METADATA_CONFLICT,
    DOWNLOAD_TURN_STALE,
    prepare_selection_scope,
)
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_ACQUIRE_ROUTE,
    LiteratureAcquire,
)
from service.platform.content import ProjectRef
from service.platform.context import ProductTaskType

ACQUIRE_TASK_REQUIRED = "fulltext_authorization_task_required"
ACQUIRE_AUTHORIZATION_REQUIRED = "fulltext_authorization_required"
ACQUIRE_PROJECT_REQUIRED = "fulltext_acquisition_project_required"
ACQUIRE_SCOPE_PREPARERS = {ProductTaskType.PRECISE_SEARCH.value: prepare_selection_scope}
ACQUIRE_IDENTIFIER_POLICY = {
    "arxiv": ("arxiv_id", normalize_arxiv_id),
    "doi": ("doi", normalize_doi),
}


def register_acquire_routes(
    app: FastAPI,
    sessions: SessionService,
    authorizer: FulltextAuthorizer | None,
    project_for_session: Callable[[str], ProjectRef | None] | None = None,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(LITERATURE_ACQUIRE_ROUTE)
    async def acquire(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        turn_id = live.publication_turn_id
        prepare_scope = ACQUIRE_SCOPE_PREPARERS.get(getattr(live, "active_task_type", ""))
        selection_workdir = live.runtime_workdir if prepare_scope is not None else None
        client_turn_id = getattr(live, "active_product_turn_id", "")
        policy = task_authorization_policy(getattr(live, "active_task_type", ""))
        if policy is None:
            return JSONResponse(
                {
                    "ok": False,
                    "error": ACQUIRE_TASK_REQUIRED,
                    "recoverable": True,
                    "action": TASK_ACTIVATION_REQUIRED_ACTION,
                },
                HTTP_400_BAD_REQUEST,
            )
        if authorizer is None:
            return JSONResponse(
                {"ok": False, "error": ACQUIRE_TASK_REQUIRED, "recoverable": False},
                HTTP_400_BAD_REQUEST,
            )
        snapshot_id = live.active_assistant_snapshot_id
        try:
            query = LiteratureAcquire.model_validate(json.loads(await request.body()))
            run = scoped_relative(query.run)
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": "acquire_request_invalid"}, HTTP_400_BAD_REQUEST
            )
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        project = project_for_session(live.id) if project_for_session is not None else None
        if project_for_session is not None and live.project_id and project is None:
            return JSONResponse(
                {"ok": False, "error": ACQUIRE_PROJECT_REQUIRED}, HTTP_400_BAD_REQUEST
            )
        try:
            task_context = verified_authorization_context(
                live, policy.task_type, workspace=query.run
            )
        except ValueError as error:
            return JSONResponse(
                {
                    "ok": False,
                    "error": ACQUIRE_TASK_REQUIRED,
                    "reason": str(error),
                    "recoverable": True,
                    "action": TASK_ACTIVATION_REQUIRED_ACTION,
                },
                HTTP_400_BAD_REQUEST,
            )
        if sessions.bridge_caller(live.id) is not live or live.publication_turn_id != turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        if prepare_scope is not None:
            assert selection_workdir is not None
            try:
                scope = await activities.to_thread(
                    ActivityDomain.BRIDGE, prepare_scope, selection_workdir, query.run
                )
                if (
                    sessions.bridge_caller(live.id) is not live
                    or live.publication_turn_id != turn_id
                    or live.active_assistant_snapshot_id != snapshot_id
                    or getattr(live, "active_product_turn_id", "") != client_turn_id
                ):
                    return JSONResponse(
                        {"ok": False, "error": DOWNLOAD_TURN_STALE}, HTTP_400_BAD_REQUEST
                    )
                for paper in query.papers:
                    field, normalize = ACQUIRE_IDENTIFIER_POLICY[paper.identifier_kind]
                    identifier = scope.identifiers.get(paper.paper_id, {}).get(field, "")
                    if (
                        paper.paper_id not in scope.papers
                        or not identifier
                        or normalize(identifier).casefold()
                        != normalize(paper.identifier).casefold()
                    ):
                        raise ValueError(DOWNLOAD_METADATA_CONFLICT)
            except (ValueError, OSError) as error:
                return JSONResponse(
                    {"ok": False, "error": DOWNLOAD_METADATA_CONFLICT, "reason": str(error)},
                    HTTP_400_BAD_REQUEST,
                )
        # Authorization is decided for the whole batch before any byte leaves the
        # machine: a partial grant must not become an authorization oracle.
        authorizations = {}
        try:
            workspace = fulltext_binding_workspace(live, policy.task_type)
        except ValueError as exc:
            return JSONResponse(
                {"ok": False, "error": ACQUIRE_AUTHORIZATION_REQUIRED, "reason": str(exc)},
                HTTP_400_BAD_REQUEST,
            )
        for paper in query.papers:
            try:
                authorizer.require(
                    session_id=live.id,
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=policy.authorization_type,
                    ref_id=PAPER_REF_PREFIX + paper.paper_id,
                    task_context=task_context,
                    client_turn_id=client_turn_id,
                )
                binding = fulltext_binding_scope(
                    (
                        authorizer.effective_scope(
                            session_id=live.id,
                            snapshot_id=snapshot_id,
                            turn_id=turn_id,
                            authorization_type=policy.authorization_type,
                            client_turn_id=client_turn_id,
                            task_context=task_context,
                        )
                        if not workspace
                        else None
                    ),
                    PAPER_REF_PREFIX + paper.paper_id,
                    session_id=live.id,
                    project_id=getattr(live, "project_id", "") or "",
                    workspace=workspace,
                    task_context=task_context,
                )
                authorizations[paper.paper_id] = binding.authorization_id
            except ValueError as exc:
                return JSONResponse(
                    {"ok": False, "error": ACQUIRE_AUTHORIZATION_REQUIRED, "reason": str(exc)},
                    HTTP_400_BAD_REQUEST,
                )
        try:
            outcome = await activities.to_thread(
                ActivityDomain.BRIDGE,
                acquire_fulltexts,
                tuple(
                    AcquirePaper(
                        paper_id=paper.paper_id,
                        identifier=paper.identifier,
                        identifier_kind=paper.identifier_kind,
                        title=paper.title,
                    )
                    for paper in query.papers
                ),
                scope=AcquisitionScope(
                    live.id,
                    getattr(live, "project_id", "") or "",
                    run,
                    authorizations=authorizations,
                ),
            )
        except (ValueError, OSError) as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        if (
            sessions.bridge_caller(live.id) is not live
            or live.publication_turn_id != turn_id
            or live.active_assistant_snapshot_id != snapshot_id
            or getattr(live, "active_product_turn_id", "") != client_turn_id
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            if (
                verified_authorization_context(live, policy.task_type, workspace=query.run)
                != task_context
            ):
                raise ValueError(DOWNLOAD_TURN_STALE)
            if fulltext_binding_workspace(live, policy.task_type) != workspace:
                raise ValueError(DOWNLOAD_TURN_STALE)
        except ValueError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        return JSONResponse(outcome.payload())

    app.include_router(router)
    return router


__all__ = ["register_acquire_routes"]
