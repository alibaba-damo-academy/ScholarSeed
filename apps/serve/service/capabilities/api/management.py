"""Session-bound discovery and confirmed writes through the shared Skill owner."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from service.capabilities.domain import (
    SKILL_CONFIRM_APPROVE,
    SKILL_CONFIRM_DENY,
    SKILL_CONFIRM_TIMEOUT_SECONDS,
    SKILL_MANAGEMENT_REQUESTS,
    SKILL_MANAGEMENT_ROUTE,
    SKILL_MUTATIONS,
    SKILL_REPLAY_LIMIT,
)
from service.capabilities.service.management import SkillManagement, SkillManagementError
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.service.sessions import PRODUCT_PERMISSION_MODES, SessionService
from service.platform.activity import Activities
from service.platform.bridge import BRIDGE_CALLBACK_REQUEST_HEADER, BRIDGE_CALLBACK_TURN_HEADER
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES

SKILL_ACCESS_DENIED = "skill_access_denied"
SKILL_PERMISSION_DENIED = "skill_permission_denied"
SKILL_REQUEST_CONFLICT = "skill_request_conflict"
SKILL_USER_DENIED = "user_denied"


def register_skill_management(
    app: FastAPI,
    sessions: SessionService,
    manager: SkillManagement,
    *,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])
    mutations = asyncio.Lock()
    receipts: dict[tuple[str, str, str], tuple[str, dict[str, Any]]] = {}

    async def execute(operation: str, request: Request) -> dict[str, Any]:
        live = bridge_caller(request, sessions)
        if live is None or not live.publication_turn_id or not live.active_product_turn_id:
            raise SkillManagementError(403, SKILL_ACCESS_DENIED)
        turn_id = live.publication_turn_id
        generation = (
            live.active_product_turn_id,
            live.product_turn_generation,
            live.interrupt_generation,
            live.attachment_generation,
            live.turn_activity,
            live.bridge_token,
        )
        if (
            not request.headers.get(BRIDGE_CALLBACK_REQUEST_HEADER)
            or request.headers.get(BRIDGE_CALLBACK_TURN_HEADER) != turn_id
        ):
            raise SkillManagementError(403, SKILL_ACCESS_DENIED)

        def current() -> None:
            if (
                bridge_caller(request, sessions) is not live
                or live.publication_turn_id != turn_id
                or generation
                != (
                    live.active_product_turn_id,
                    live.product_turn_generation,
                    live.interrupt_generation,
                    live.attachment_generation,
                    live.turn_activity,
                    live.bridge_token,
                )
            ):
                raise SkillManagementError(403, SKILL_ACCESS_DENIED)

        def authorize() -> None:
            current()
            mode = sessions.mode(live.id)
            if (
                mode.get("mode") not in PRODUCT_PERMISSION_MODES
                or mode.get("active_mode") not in PRODUCT_PERMISSION_MODES
            ):
                raise SkillManagementError(403, SKILL_PERMISSION_DENIED)

        request_type = SKILL_MANAGEMENT_REQUESTS.get(operation)
        if request_type is None:
            raise SkillManagementError(400, "bridge_operation_unknown")
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                raise SkillManagementError(413, "bridge_request_too_large")
        try:
            command = request_type.model_validate_json(raw)
        except ValueError:
            raise SkillManagementError(400, "bridge_invalid_parameters") from None
        current()
        data = command.model_dump()
        handlers = {
            "search": lambda: manager.marketplace(**data),
            "detail": lambda: manager.marketplace_detail(**data),
            "list": lambda: manager.list_skills(user_id=live.user_id),
            "document": lambda: manager.skill_document(**data, user_id=live.user_id),
            "install": lambda: manager.marketplace_install(
                data["slug"],
                {"version": data["version"], "enabled": data["enabled"]},
                user_id=live.user_id,
                authorize=authorize,
            ),
            "enable": lambda: manager.activate_skill(
                data["name"], user_id=live.user_id, authorize=authorize
            ),
            "disable": lambda: manager.deactivate_skill(
                data["name"], user_id=live.user_id, authorize=authorize
            ),
            "update": lambda: manager.update_skill(
                data["name"],
                {"version": data["version"], "expectedVersion": data["expected_version"]},
                user_id=live.user_id,
                authorize=authorize,
            ),
            "delete": lambda: manager.delete_skill(
                data["name"], user_id=live.user_id, authorize=authorize
            ),
        }
        if operation not in SKILL_MUTATIONS:
            result = await handlers[operation]()
            current()
            return {"ok": True, **result}
        async with mutations:
            authorize()
            key = (live.id, turn_id, data["client_op_id"])
            fingerprint = json.dumps([operation, data], sort_keys=True)
            if key in receipts:
                previous, result = receipts[key]
                if previous != fingerprint:
                    raise SkillManagementError(409, SKILL_REQUEST_CONFLICT)
                return {**result, "replayed": True}
            for stale in tuple(receipts):
                caller = sessions.bridge_caller(stale[0])
                if caller is None or caller.publication_turn_id != stale[1]:
                    del receipts[stale]
            if len(receipts) >= SKILL_REPLAY_LIMIT:
                raise SkillManagementError(409, "skill_request_capacity")
            question = {
                "id": "skill-management-" + uuid.uuid4().hex,
                "header": "本地技能操作确认",
                "question": "是否允许对本机技能执行 "
                + operation
                + "？\n"
                + json.dumps(
                    {name: value for name, value in data.items() if name != "client_op_id"},
                    ensure_ascii=False,
                ),
                "options": [
                    {
                        "label": SKILL_CONFIRM_APPROVE,
                        "description": "仅执行上述目标和版本，不操作其他技能。",
                    },
                    {"label": SKILL_CONFIRM_DENY, "description": "拒绝本次操作，不修改本机技能。"},
                ],
            }
            decision = await live.interactions.request_product_input(
                question,
                turn_id=turn_id,
                timeout_seconds=SKILL_CONFIRM_TIMEOUT_SECONDS,
                activity=live.turn_activity,
            )
            authorize()
            answers = decision.get("answers") or {}
            approved = (
                not decision.get("cancelled")
                and not decision.get("timed_out")
                and any(value == SKILL_CONFIRM_APPROVE for value in answers.values())
            )
            if approved:
                result = {"ok": True, **await handlers[operation]()}
            else:
                result = {"ok": False, "error": SKILL_USER_DENIED}
            receipts[key] = (fingerprint, result)
            return result

    @router.post(SKILL_MANAGEMENT_ROUTE + "{operation}")
    async def operate(operation: str, request: Request) -> JSONResponse:
        try:
            return JSONResponse(await execute(operation, request))
        except SkillManagementError as error:
            return JSONResponse({"ok": False, "error": error.detail}, error.status)

    app.include_router(router)
    return router
