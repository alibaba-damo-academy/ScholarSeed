"""Authenticated plan operations for the current product execution scope."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN, HTTP_409_CONFLICT

from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.plan import (
    PLAN_START_REQUIRED,
    PlanConflict,
    PlanExecutionError,
    completion_ids,
    progress_transitions,
    reconcilable_ids,
)
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    PLAN_ACTION_STATUSES,
    PLAN_COMPLETE_ACTION,
    PLAN_ENABLE_OPERATION,
    PLAN_INITIAL_REVISION,
    PLAN_MUTATIONS,
    PLAN_NOT_ENABLED,
    PLAN_RECONCILE_ACTION,
    PLAN_ROUTE_PREFIX,
    PlanEnable,
    PlanRead,
)

PLAN_CONFLICT_ACTION = (
    "Read plan/get before retrying and correct against the declared tool's request schema and current state. "
    "For structural edits send the complete items required by this operation's contract; "
    "do not rewrite execution history. "
    "Preserve root ids, content and order, existing parent links, and started leaf identities. "
    "Use revise with a reason only for a real scope/structure change, not to bypass a rejected "
    "partial snapshot or execution constraint. Use the returned plan_id, revision and turn_id, "
    "and a fresh request_id for changed arguments; do not retry unchanged invalid arguments."
)


def register_plan_routes(
    app: FastAPI, sessions: SessionService, *, activities: Activities
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])

    @router.post(PLAN_ROUTE_PREFIX + "{operation}")
    async def plan(request: Request, operation: str) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        activity = live.turn_activity
        turn_id = live.publication_turn_id

        def current(state: dict | None = None) -> dict:
            state = live.plans.current() if state is None else state
            metadata = state.get("plan") or {}
            transitions = progress_transitions(state["items"], state)
            reconcilable = reconcilable_ids(state)
            completable = completion_ids(state)
            return {
                "turn_id": turn_id,
                **state,
                "expected_revision": metadata.get("revision", PLAN_INITIAL_REVISION),
                "transitions": transitions,
                "actions": {
                    identity: [
                        action
                        for action, status in PLAN_ACTION_STATUSES.items()
                        if action not in {PLAN_RECONCILE_ACTION, PLAN_COMPLETE_ACTION}
                        and status in allowed
                    ]
                    + ([PLAN_RECONCILE_ACTION] if identity in reconcilable else [])
                    + ([PLAN_COMPLETE_ACTION] if identity in completable else [])
                    for identity, allowed in transitions.items()
                },
            }

        raw = await request.body()
        if (
            sessions.bridge_caller(live.id) is not live
            or live.publication_turn_id != turn_id
            or live.turn_activity is not activity
        ):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        try:
            data = json.loads(raw)
            if operation == PLAN_ENABLE_OPERATION:
                enable = PlanEnable.model_validate(data)
                await activities.finish(
                    ActivityDomain.BRIDGE, lambda: live.enable_plan(enable, turn_id)
                )
                return JSONResponse({"ok": True, "enabled": True, **current()})
            if not await activities.finish_thread(ActivityDomain.BRIDGE, live.plans.enabled):
                return JSONResponse({"ok": False, "error": PLAN_NOT_ENABLED}, HTTP_403_FORBIDDEN)
            if (
                sessions.bridge_caller(live.id) is not live
                or live.publication_turn_id != turn_id
                or live.turn_activity is not activity
            ):
                return JSONResponse(
                    {"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN
                )
            if operation == "get":
                PlanRead.model_validate(data)
                result = live.plans.current()
            elif operation in PLAN_MUTATIONS:
                command = PLAN_MUTATIONS[operation].model_validate(data)
                result = (
                    await activities.finish(ActivityDomain.BRIDGE, lambda: live.write_plan(command))
                ).payload
            else:
                raise ValueError("plan_operation_invalid")
        except PermissionError as error:
            return JSONResponse(
                {
                    "ok": False,
                    "error": str(error),
                    "next_action": "Read plan/get in the current active turn before retrying. "
                    "Use its turn_id for explicit bridge requests; update_plan binds its trusted "
                    "callback turn automatically. Do not reuse an earlier turn_id or repeat a "
                    "rejected mutation unchanged.",
                },
                HTTP_403_FORBIDDEN,
            )
        except PlanConflict as error:
            return JSONResponse(
                {
                    "ok": False,
                    "error": str(error),
                    "current": current(),
                    "next_action": PLAN_CONFLICT_ACTION,
                },
                HTTP_409_CONFLICT,
            )
        except PlanExecutionError as error:
            return JSONResponse(
                {
                    "ok": False,
                    "error": str(error),
                    "step_ids": error.identities,
                    "current": current(),
                    "next_action": "Read plan/get and use the returned state/transitions with the declared tool contract. "
                    + (
                        "Keep the current revision. Mark these leaves in_progress before actually "
                        "executing their work, then complete them. Do not backdate starts or claim "
                        "unrecorded work was timed. If work already completed without a start, verify "
                        "its result and use reconcile for those leaves, with a reason stating the observed "
                        "completion evidence. Completion is recorded without execution time. Block only "
                        "for an actual obstacle; do not issue start/finish merely to repair history. "
                        "Only create and start a separate verification leaf when actually performing "
                        "authorized verification, not as a substitute for missing work evidence."
                        if str(error) == PLAN_START_REQUIRED
                        else "Use existing ids, preserve started leaves, and refine only unstarted steps."
                    ),
                },
                HTTP_400_BAD_REQUEST,
            )
        except ValueError as error:
            return JSONResponse(
                {
                    "ok": False,
                    "error": str(error),
                    "current": current(),
                    "next_action": PLAN_CONFLICT_ACTION,
                },
                HTTP_400_BAD_REQUEST,
            )
        return JSONResponse({"ok": True, **current(result)})

    app.include_router(router)
    return router
