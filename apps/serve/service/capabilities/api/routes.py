"""ScholarSeed product routes for Codex-native Skills."""

from __future__ import annotations

import json
import shutil
from collections.abc import Awaitable
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import (
    APIRouter,
    Body,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    UploadFile,
)

from service.capabilities.domain import SKILL_MANIFEST_NAME
from service.capabilities.service.install import (
    MAX_DOCUMENT_BYTES,
    SkillDuplicateError,
    SkillPackageError,
    install_skill_archive,
    install_skill_document,
    preview_skill_upload,
)
from service.capabilities.service.management import SkillManagement, SkillManagementError
from service.capabilities.service.skills import (
    SKILL_INSTALLATION_CREATED,
    SKILL_INSTALLATION_GITHUB,
    SKILL_INSTALLATION_UPLOAD,
)
from service.identity.utils import request_user_id
from service.paths import SERVICE_SKILLS_DIR
from service.platform.activity import Activities, ActivityDomain
from service.platform.http_activity import execution_admission

SKILL_ERROR_DUPLICATE = "duplicate_name"
SKILL_ERROR_INVALID = "invalid_package"
SKILL_ERROR_IMMUTABLE = "immutable_skill"
SKILL_NAME_MAX = 64
SKILL_DESCRIPTION_MAX = 200
GITHUB_HOST = "github.com"
GITHUB_RAW_HOST = "raw.githubusercontent.com"
GITHUB_DEFAULT_BRANCHES = ("main", "master")
GITHUB_FETCH_TIMEOUT_SECONDS = 20.0


def _install_error(exc: SkillPackageError) -> HTTPException:
    if isinstance(exc, SkillDuplicateError):
        return HTTPException(
            422,
            {
                "code": SKILL_ERROR_DUPLICATE,
                "message": str(exc),
                "name": exc.skill_name,
            },
        )
    return HTTPException(422, {"code": SKILL_ERROR_INVALID, "message": str(exc)})


def _github_manifest_urls(repo_url: str) -> tuple[str, ...]:
    parsed = urlparse(repo_url.strip())
    if parsed.scheme != "https" or parsed.hostname != GITHUB_HOST:
        raise HTTPException(422, "仅支持公开的 GitHub HTTPS 仓库地址")
    parts = [part for part in parsed.path.removesuffix(".git").strip("/").split("/") if part]
    if len(parts) != 2:
        raise HTTPException(422, "仓库地址必须是 https://github.com/<owner>/<repo>")
    owner, repository = parts
    return tuple(
        f"https://{GITHUB_RAW_HOST}/{owner}/{repository}/{branch}/{SKILL_MANIFEST_NAME}"
        for branch in GITHUB_DEFAULT_BRANCHES
    )


def register_capability_routes(
    app: FastAPI,
    *,
    activities: Activities,
    workspace: Path | None = None,
) -> None:
    """Mount a product catalogue whose discovery source is App Server skills/list."""

    router = APIRouter(
        dependencies=[Depends(execution_admission(activities, ActivityDomain.RUNTIME))]
    )
    manager = SkillManagement(
        app.state.skill_catalog,
        lambda: getattr(app.state, "runtime_service", None),
        lambda: workspace or Path.cwd(),
        lambda: (
            app.state.settings_service.runtime_executable()
            if getattr(app.state, "settings_service", None)
            else ""
        ),
    )
    app.state.skill_management = manager

    async def managed(operation: Awaitable[Any]) -> Any:
        try:
            return await operation
        except SkillManagementError as error:
            raise HTTPException(error.status, error.detail) from error

    async def configure_installed(
        name: str, enabled: bool = True, *, installation_source: str | None = None, user_id: str
    ) -> None:
        await managed(
            manager.configure_installed(
                name, enabled, installation_source=installation_source, user_id=user_id
            )
        )

    @router.get("/api/capabilities/skills/marketplace")
    async def marketplace(
        query: str = "", cursor: str = "", label: str = "", locale: str = "en"
    ) -> dict[str, Any]:
        return await managed(
            manager.marketplace(query=query, cursor=cursor, label=label, locale=locale)
        )

    @router.get("/api/capabilities/skills/marketplace/labels")
    async def marketplace_labels(locale: str = "en") -> dict[str, Any]:
        return await managed(manager.marketplace_labels(locale))

    @router.get("/api/capabilities/skills/marketplace/items/{slug}")
    async def marketplace_detail(
        slug: str, version: str = "", locale: str = "en"
    ) -> dict[str, Any]:
        return await managed(manager.marketplace_detail(slug, version, locale))

    @router.post("/api/capabilities/skills/marketplace/items/{slug}/install")
    async def marketplace_install(
        slug: str, request: Request, body: dict[str, Any] = Body(...)
    ) -> dict[str, Any]:
        return await managed(
            manager.marketplace_install(slug, body, user_id=request_user_id(request))
        )

    @router.get("/api/capabilities/skills")
    async def list_skills(
        request: Request, surface: str | None = None, locale: str | None = None
    ) -> dict[str, Any]:
        return await managed(
            manager.list_skills(user_id=request_user_id(request), surface=surface, locale=locale)
        )

    @router.post("/api/capabilities/skills/{name}/update")
    async def update_skill(
        name: str, request: Request, body: dict[str, Any] = Body(...)
    ) -> dict[str, Any]:
        return await managed(manager.update_skill(name, body, user_id=request_user_id(request)))

    @router.post("/api/capabilities/skills/{name}/activate")
    async def activate_skill(name: str, request: Request) -> dict[str, Any]:
        return await managed(manager.activate_skill(name, user_id=request_user_id(request)))

    @router.delete("/api/capabilities/skills/{name}/activate")
    async def deactivate_skill(name: str, request: Request) -> dict[str, Any]:
        return await managed(manager.deactivate_skill(name, user_id=request_user_id(request)))

    @router.get("/api/capabilities/skills/{name}/document")
    async def skill_document(name: str, request: Request) -> dict[str, Any]:
        return await managed(manager.skill_document(name, user_id=request_user_id(request)))

    @router.delete("/api/capabilities/skills/{name}")
    async def delete_skill(name: str, request: Request) -> dict[str, Any]:
        return await managed(manager.delete_skill(name, user_id=request_user_id(request)))

    @router.post("/api/capabilities/skills/upload/preview")
    async def preview_upload(file: UploadFile = File(...)) -> dict[str, Any]:
        try:
            preview = preview_skill_upload(await file.read(), file.filename or "")
            if (SERVICE_SKILLS_DIR / preview["name"]).exists():
                raise SkillDuplicateError(preview["name"])
            return {"preview": preview}
        except SkillPackageError as exc:
            raise _install_error(exc) from exc

    @router.post("/api/capabilities/skills/upload")
    async def upload_skill(
        request: Request,
        file: UploadFile = File(...),
    ) -> dict[str, Any]:
        payload = await file.read()
        filename = (file.filename or "").strip()
        fallback = Path(filename).stem or "skill"
        try:
            preview_skill_upload(payload, filename)
            if filename.lower().endswith(".zip") or payload[:2] == b"PK":
                installed = install_skill_archive(
                    payload,
                    SERVICE_SKILLS_DIR,
                    fallback_name=fallback,
                    overwrite=False,
                )
            else:
                installed = install_skill_document(
                    payload.decode("utf-8", errors="replace"),
                    SERVICE_SKILLS_DIR,
                    fallback_name=fallback,
                    overwrite=False,
                )
        except SkillPackageError as exc:
            raise _install_error(exc) from exc
        try:
            await configure_installed(
                installed.name,
                installation_source=SKILL_INSTALLATION_UPLOAD,
                user_id=request_user_id(request),
            )
        except Exception:
            shutil.rmtree(installed.path)
            raise
        return {"installed": installed.to_dict()}

    @router.post("/api/capabilities/skills/create")
    async def create_skill(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        name = str(body.get("name") or "").strip()
        description = str(body.get("description") or "").strip()
        instructions = str(body.get("instructions") or "").strip()
        if not name or len(name) > SKILL_NAME_MAX:
            raise HTTPException(422, f"技能名必填且不超过 {SKILL_NAME_MAX} 字")
        if not description or len(description) > SKILL_DESCRIPTION_MAX:
            raise HTTPException(422, f"描述必填且不超过 {SKILL_DESCRIPTION_MAX} 字")
        document = (
            "---\n"
            f"name: {json.dumps(name, ensure_ascii=False)}\n"
            f"description: {json.dumps(description, ensure_ascii=False)}\n"
            "---\n\n"
            f"{instructions or '写清楚这个技能应如何逐步执行。'}\n"
        )
        try:
            installed = install_skill_document(
                document,
                SERVICE_SKILLS_DIR,
                fallback_name=name,
            )
        except SkillPackageError as exc:
            raise _install_error(exc) from exc
        await configure_installed(
            installed.name,
            installation_source=SKILL_INSTALLATION_CREATED,
            user_id=request_user_id(request),
        )
        return {"installed": installed.to_dict()}

    @router.post("/api/capabilities/skills/import/github")
    async def import_skill_from_github(
        request: Request, body: dict[str, Any] = Body(...)
    ) -> dict[str, Any]:
        candidates = _github_manifest_urls(str(body.get("url") or ""))
        failed_request = False
        async with httpx.AsyncClient(
            timeout=GITHUB_FETCH_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as client:
            for candidate in candidates:
                try:
                    response = await client.get(candidate)
                    if response.status_code == 404:
                        continue
                    response.raise_for_status()
                    payload = response.content
                except httpx.HTTPError:
                    failed_request = True
                    continue
                if len(payload) > MAX_DOCUMENT_BYTES:
                    raise HTTPException(422, f"{SKILL_MANIFEST_NAME} 超过体积上限")
                try:
                    installed = install_skill_document(
                        payload.decode("utf-8", errors="replace"),
                        SERVICE_SKILLS_DIR,
                    )
                except SkillPackageError as exc:
                    raise _install_error(exc) from exc
                await configure_installed(
                    installed.name,
                    installation_source=SKILL_INSTALLATION_GITHUB,
                    user_id=request_user_id(request),
                )
                return {"installed": installed.to_dict(), "source": candidate}
        raise HTTPException(
            422,
            (
                f"未能读取该仓库根目录的 {SKILL_MANIFEST_NAME}"
                if failed_request
                else f"未能在该仓库根目录找到 {SKILL_MANIFEST_NAME}"
            ),
        )

    app.include_router(router)


__all__ = ["register_capability_routes"]
