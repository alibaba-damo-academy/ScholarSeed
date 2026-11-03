"""Read-only Codex skill inventory routes for ScholarSeed."""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request

from service.chat.service.skills import SkillService
from service.identity.service.skill_credentials import SkillCredentialService
from service.identity.utils import bearer_or_cookie, request_user_id
from service.platform.activity import Activities, ActivityDomain
from service.platform.http_activity import execution_admission


def mount_skill_routes(
    app: FastAPI,
    *,
    activities: Activities,
    skills: SkillService,
    credentials: SkillCredentialService,
) -> None:
    """Forward typed Codex skill discovery without restoring legacy capability APIs."""

    router = APIRouter(
        dependencies=[Depends(execution_admission(activities, ActivityDomain.RUNTIME))]
    )

    async def process_environment(request: Request) -> dict[str, str]:
        return await credentials.ensure(request_user_id(request), bearer_or_cookie(request))

    @router.get("/api/serve/skills")
    async def list_skills(request: Request, force_reload: bool = False) -> dict:
        try:
            return await skills.payload(
                user_id=request_user_id(request),
                force_reload=force_reload,
                process_environment=await process_environment(request),
            )
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(503, str(exc)) from exc

    @router.get("/api/serve/skills/{name}/document")
    async def skill_document(name: str, request: Request) -> dict[str, str]:
        try:
            document = await skills.document(
                name,
                user_id=request_user_id(request),
                process_environment=await process_environment(request),
            )
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(503, str(exc)) from exc
        if document is None:
            raise HTTPException(404, "skill document not found")
        return {"document": document}

    app.include_router(router)


__all__ = ["mount_skill_routes"]
