"""Authenticated activation of current-turn product task identity."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from service.chat.api.bridge import bridge_caller
from service.chat.service.sessions import SessionService
from service.chat.service.tasks import (
    TASK_ACTIVATION_POLICIES,
    TASK_LEASE_SOURCE_SKILL_RUN,
    ProductTaskLease,
)
from service.platform.bridge import BRIDGE_MAX_REQUEST_BYTES, TASK_ACTIVATE_ROUTE, TaskActivate
from service.platform.context import ProductTaskType

TASK_BINDING_MAX_BYTES = 16_384


def _failure(reason: str, action: str, status: int = HTTP_400_BAD_REQUEST) -> JSONResponse:
    return JSONResponse(
        {
            "ok": False,
            "error": "task_activation_failed",
            "reason": reason,
            "recoverable": reason not in {"bridge_access_denied", "task_context_stale"},
            "action": action,
        },
        status,
    )


def _workspace(root: Path, value: str) -> tuple[Path, str]:
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("task_workspace_invalid")
    resolved = (root / relative).resolve()
    resolved.relative_to(root.resolve())
    return resolved, str(relative)


def _binding(workspace: Path, filename: str) -> dict[str, object]:
    path = workspace / filename
    if path.is_symlink() or path.resolve().parent != workspace:
        raise ValueError("task_binding_invalid")
    if path.stat().st_size > TASK_BINDING_MAX_BYTES:
        raise ValueError("task_binding_invalid")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("task_binding_invalid")
    return value


def register_task_routes(app: FastAPI, sessions: SessionService) -> APIRouter:
    router = APIRouter()

    @router.post(TASK_ACTIVATE_ROUTE)
    async def activate_task(request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return _failure(
                "bridge_access_denied", "run inside the active ScholarSeed turn", HTTP_403_FORBIDDEN
            )
        raw = await request.body()
        if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
            return _failure("bridge_request_too_large", "send a smaller activation request")
        try:
            command = TaskActivate.model_validate(json.loads(raw))
            task_type = ProductTaskType(command.task_type)
            policy = TASK_ACTIVATION_POLICIES.get(task_type)
            if policy is None or policy.skill_name != command.skill_name:
                raise ValueError("task_skill_mismatch")
            if (
                not live.active_product_turn_id
                or live.current_task is None
                or live.current_task.done()
            ):
                raise ValueError("task_context_stale")
            workspace, relative_workspace = _workspace(live.runtime_workdir, command.workspace)
            identity = await live.skill_identity_by_name(command.skill_name, force_reload=False)
            if identity is None:
                raise ValueError("task_skill_unavailable")
            manifest = Path(str(identity.get("path") or "")).resolve()
            skill_root = manifest.parent
            if skill_root != Path(command.skill_path).resolve():
                raise ValueError("task_skill_mismatch")
            if str(identity.get("version") or "") != command.skill_version:
                raise ValueError("task_skill_version_mismatch")
            binding = _binding(workspace, policy.binding_file)
            if (
                binding.get("skill") != str(skill_root)
                or binding.get("version") != command.skill_version
            ):
                raise ValueError("task_binding_mismatch")
            binding_workspace = binding.get("workspace")
            if (
                binding_workspace is not None
                and Path(str(binding_workspace)).resolve() != workspace
            ):
                raise ValueError("task_binding_mismatch")
            binding_run = binding.get("run_id")
            if not isinstance(binding_run, str) or not binding_run:
                binding_run = (
                    policy.derived_run_prefix
                    + sha256(relative_workspace.encode()).hexdigest()[: policy.derived_run_chars]
                )
            if binding_run != command.run_id:
                raise ValueError("task_run_mismatch")
            lease = ProductTaskLease(
                task_type=task_type,
                turn_id=live.active_product_turn_id,
                generation=live.product_turn_generation,
                source=TASK_LEASE_SOURCE_SKILL_RUN,
                skill_name=command.skill_name,
                skill_version=command.skill_version,
                skill_path=str(skill_root),
                workspace=relative_workspace,
                run_id=command.run_id,
            )
            live.set_task_lease(lease)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            reason = (
                str(error)
                if isinstance(error, ValueError) and str(error)
                else "task_binding_invalid"
            )
            return _failure(reason, "re-run the bound workspace launcher in the active turn")
        return JSONResponse({"ok": True, "task_type": command.task_type, "run_id": command.run_id})

    app.include_router(router)
    return router
