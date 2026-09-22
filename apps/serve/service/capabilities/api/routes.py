"""ScholarSeed product routes for Codex-native Skills."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile

from scholarseed_runtime.contract.inventory import SkillInventory, SkillView
from service.capabilities.service.install import (
    MAX_DOCUMENT_BYTES,
    SKILL_MANIFEST_NAME,
    SkillDuplicateError,
    SkillPackageError,
    install_skill_archive,
    install_skill_document,
)
from service.capabilities.service.skills import (
    SkillCatalog,
    SkillProductState,
    load_skill_state,
    replace_skill_state,
    save_skill_state,
)
from service.identity.utils import request_user_id
from service.paths import SERVICE_SKILLS_DIR

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
    workspace: Path | None = None,
) -> None:
    """Mount a product catalogue whose discovery source is App Server skills/list."""

    catalog: SkillCatalog = app.state.skill_catalog

    def current_workspace() -> Path:
        return (workspace or Path.cwd()).expanduser().resolve()

    async def inventory(
        request: Request,
        *,
        force_reload: bool = False,
    ) -> SkillInventory:
        runtime = getattr(app.state, "runtime_service", None)
        if runtime is None or not hasattr(runtime, "skill_inventory"):
            raise HTTPException(503, "codex_skill_inventory_unavailable")
        settings = getattr(app.state, "settings_service", None)
        executable = settings.runtime_executable() if settings is not None else ""
        try:
            return await runtime.skill_inventory(
                cwd=current_workspace(),
                executable=executable,
                process_environment={},
                force_reload=force_reload,
            )
        except Exception as exc:  # noqa: BLE001 - product edge returns a safe readiness error
            raise HTTPException(503, "codex_skill_inventory_unavailable") from exc

    async def apply_state(state: SkillProductState) -> None:
        runtime = app.state.runtime_service
        previous = load_skill_state()
        try:
            await runtime.configure_skills(cwd=current_workspace(), state=state)
        except Exception as exc:
            await runtime.configure_skills(cwd=current_workspace(), state=previous)
            raise HTTPException(503, "技能状态同步失败，请重试") from exc

    async def mark_installed_enabled(name: str) -> None:
        state = load_skill_state()
        await apply_state(
            replace_skill_state(
                state,
                disabled_skills=state.disabled_skills - {name},
                deleted_skills=state.deleted_skills - {name},
            )
        )

    async def find_skill(
        request: Request,
        name: str,
    ) -> tuple[SkillView, SkillProductState]:
        state = load_skill_state()
        skill = catalog.find(await inventory(request, force_reload=True), state, name)
        if skill is None:
            raise HTTPException(404, f"unknown skill {name!r}")
        return skill, state

    @app.get("/api/capabilities/skills")
    async def list_skills(request: Request, surface: str | None = None) -> dict[str, Any]:
        if surface is not None and not catalog.supports_surface(surface):
            raise HTTPException(422, "unknown_skill_surface")
        state = load_skill_state()
        try:
            discovered = await app.state.runtime_service.configure_skills(
                cwd=current_workspace(), state=state
            )
        except Exception as exc:
            raise HTTPException(503, "codex_skill_inventory_unavailable") from exc
        return {
            "skills": catalog.payloads(
                discovered, state, surface=surface, user_id=request_user_id(request)
            ),
            "revision": discovered.revision,
            "cwd": str(discovered.cwd),
            "errors": [
                {"path": str(error.path), "message": error.message} for error in discovered.errors
            ],
        }

    @app.post("/api/capabilities/skills/{name}/activate")
    async def activate_skill(name: str, request: Request) -> dict[str, Any]:
        _skill, state = await find_skill(request, name)
        await apply_state(
            replace_skill_state(
                state,
                disabled_skills=state.disabled_skills - {name},
                deleted_skills=state.deleted_skills - {name},
            )
        )
        return {"name": name, "active": True}

    @app.delete("/api/capabilities/skills/{name}/activate")
    async def deactivate_skill(name: str, request: Request) -> dict[str, Any]:
        skill, state = await find_skill(request, name)
        if not catalog.toggleable(skill):
            raise HTTPException(
                409,
                {
                    "code": SKILL_ERROR_IMMUTABLE,
                    "message": "产品必需技能始终开启，不可关闭",
                    "name": name,
                },
            )
        await apply_state(
            replace_skill_state(state, disabled_skills=state.disabled_skills | {name})
        )
        return {"name": name, "active": False}

    @app.get("/api/capabilities/skills/{name}/document")
    async def skill_document(name: str, request: Request) -> dict[str, Any]:
        skill, _state = await find_skill(request, name)
        manifest = catalog.manifest(skill.path).expanduser().resolve()
        try:
            document = manifest.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise HTTPException(422, f"cannot read {SKILL_MANIFEST_NAME}: {exc}") from exc
        return {"name": name, "path": str(manifest), "document": document}

    @app.delete("/api/capabilities/skills/{name}")
    async def delete_skill(name: str, request: Request) -> dict[str, Any]:
        skill, state = await find_skill(request, name)
        manifest = catalog.manifest(skill.path).expanduser().resolve()
        source = catalog.source(manifest)
        if not catalog.removable(manifest):
            raise HTTPException(403, "内置技能不可删除")
        if source == "user":
            shutil.rmtree(manifest.parent)
        else:
            save_skill_state(
                replace_skill_state(state, deleted_skills=state.deleted_skills | {name})
            )
        return {"name": name, "deleted": True}

    @app.post("/api/capabilities/skills/upload")
    async def upload_skill(
        file: UploadFile = File(...),
        overwrite: bool = Form(default=False),
    ) -> dict[str, Any]:
        payload = await file.read()
        filename = (file.filename or "").strip()
        fallback = Path(filename).stem or "skill"
        try:
            if filename.lower().endswith(".zip") or payload[:2] == b"PK":
                installed = install_skill_archive(
                    payload,
                    SERVICE_SKILLS_DIR,
                    fallback_name=fallback,
                    overwrite=overwrite,
                )
            else:
                installed = install_skill_document(
                    payload.decode("utf-8", errors="replace"),
                    SERVICE_SKILLS_DIR,
                    fallback_name=fallback,
                    overwrite=overwrite,
                )
        except SkillPackageError as exc:
            raise _install_error(exc) from exc
        await mark_installed_enabled(installed.name)
        return {"installed": installed.to_dict()}

    @app.post("/api/capabilities/skills/create")
    async def create_skill(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
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
        await mark_installed_enabled(installed.name)
        return {"installed": installed.to_dict()}

    @app.post("/api/capabilities/skills/import/github")
    async def import_skill_from_github(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
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
                await mark_installed_enabled(installed.name)
                return {"installed": installed.to_dict(), "source": candidate}
        raise HTTPException(
            422,
            (
                f"未能读取该仓库根目录的 {SKILL_MANIFEST_NAME}"
                if failed_request
                else f"未能在该仓库根目录找到 {SKILL_MANIFEST_NAME}"
            ),
        )


__all__ = ["register_capability_routes"]
