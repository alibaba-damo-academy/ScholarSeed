"""ScholarSeed product routes for Codex-native Skills."""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Awaitable
from dataclasses import replace
from importlib.metadata import version
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
from service.capabilities.service.candidates import Candidates
from service.capabilities.service.components import ComponentConflict
from service.capabilities.service.delivery import (
    InstallationStatus,
    installation_result,
    read_delivery,
)
from service.capabilities.service.descriptor import (
    PLUGIN_DESCRIPTOR,
    ComponentValidationError,
    PluginComponent,
    validate_component_submission,
    validate_component_value,
)
from service.capabilities.service.install import (
    MAX_DOCUMENT_BYTES,
    MAX_PACKAGE_BYTES,
    SkillDuplicateError,
    SkillPackageError,
    install_skill_archive,
    install_skill_document,
    plugin_installation,
    preview_skill_upload,
    recover_plugin_installation,
)
from service.capabilities.service.management import SkillManagement, SkillManagementError
from service.capabilities.service.package import read_package
from service.capabilities.service.plugins import (
    PLUGIN_CAPABILITIES,
    PLUGIN_DISTRIBUTION,
    PLUGIN_ORIGIN_KIND,
    component_action,
    identity_snapshot,
    installed_snapshot,
)
from service.capabilities.service.skills import (
    SKILL_INSTALLATION_CREATED,
    SKILL_INSTALLATION_GITHUB,
    SKILL_INSTALLATION_UPLOAD,
    SkillCatalog,
    SkillProductState,
    load_skill_state,
    replace_skill_state,
    restore_skill_state,
    skill_state_record,
)
from service.capabilities.service.ui import UI_INITIALIZATION_FAILED, read_ui
from service.chat.persistence.catalog import SessionPrincipal
from service.identity.utils import request_owner_id, request_user_id, require_host_process
from service.paths import SERVICE_BUNDLED_UI, SERVICE_SKILLS_DIR
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
logger = logging.getLogger(__name__)


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


UI_DESKTOP_DISTRIBUTION_ONLY = "ui_desktop_distribution_only"


def register_capability_routes(
    app: FastAPI,
    *,
    activities: Activities,
    workspace: Path | None = None,
) -> None:
    """Browse installed packages; admit mutations through the native runtime."""

    router = APIRouter(
        dependencies=[Depends(execution_admission(activities, ActivityDomain.RUNTIME))]
    )
    catalog: SkillCatalog = app.state.skill_catalog
    components = catalog.components
    if components is not None:
        try:
            if SERVICE_BUNDLED_UI.is_file():
                components.install_ui(read_ui(SERVICE_BUNDLED_UI.read_bytes()), initialize=True)
        except (OSError, ValueError) as error:
            components.ui_error = UI_INITIALIZATION_FAILED
            logger.warning("ui_initialization_failed failure_type=%s", type(error).__name__)
    candidates = Candidates(
        host_version=version(PLUGIN_DISTRIBUTION),
        capabilities=PLUGIN_CAPABILITIES,
        components=components,
    )
    catalog.candidates = candidates

    manager = SkillManagement(
        app.state.skill_catalog,
        lambda: getattr(app.state, "runtime_service", None),
        lambda: workspace or Path.cwd(),
        lambda: (
            app.state.settings_service.runtime_executable()
            if getattr(app.state, "settings_service", None)
            else ""
        ),
        activities=activities,
    )
    app.state.skill_management = manager
    component_change = manager.component_change

    def current_workspace() -> Path:
        return manager.current_workspace()

    async def managed(operation: Awaitable[Any]) -> Any:
        try:
            return await operation
        except SkillManagementError as error:
            raise HTTPException(error.status, error.detail) from error

    async def inventory(request: Request, *, force_reload: bool = False):
        return await managed(
            manager.inventory(force_reload=force_reload, user_id=request_user_id(request))
        )

    async def sync_state(state: SkillProductState, *, user_id: str, rollback: bool = True) -> None:
        await managed(manager.apply_state(state, user_id=user_id, rollback=rollback))

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

    @app.get("/api/capabilities/skills")
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

    @app.get("/api/capabilities/skills/{name}/document")
    async def skill_document(name: str, request: Request) -> dict[str, Any]:
        return await managed(manager.skill_document(name, user_id=request_user_id(request)))

    @router.delete("/api/capabilities/skills/{name}")
    async def delete_skill(name: str, request: Request) -> dict[str, Any]:
        return await managed(manager.delete_skill(name, user_id=request_user_id(request)))

    @router.post(
        "/api/capabilities/skills/plugins/validate", dependencies=[Depends(require_host_process)]
    )
    async def validate_preview_submission(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            component = PluginComponent.model_validate(body.get("component"))
            validate_component_submission(
                component.model_dump(), str(body.get("action", "")), body.get("values")
            )
        except ComponentValidationError as error:
            return {
                "valid": False,
                "authorized": False,
                "error": str(error),
                "detail": error.detail,
            }
        except ValueError:
            return {"valid": False, "authorized": False, "error": "component_submission_invalid"}
        return {"valid": True, "authorized": False}

    @router.post(
        "/api/capabilities/skills/plugins/delivery", dependencies=[Depends(require_host_process)]
    )
    async def plugin_delivery(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        records = app.state.session_catalog
        session_id, request_id = str(body.get("session", "")), str(body.get("request", ""))
        records.require(session_id, SessionPrincipal(user_id=request_owner_id(request)))
        interaction = records.hil(request_id)
        if interaction.session_id != session_id:
            raise HTTPException(404, "plugin_delivery_not_found")
        question = interaction.payload.get("questions", [{}])[0]
        report = question.get("plugin_installation")
        if not report:
            raise HTTPException(404, "plugin_delivery_not_found")
        operation = body.get("action", "status")
        if operation not in {"status", "check", "skip", "directory"}:
            raise HTTPException(422, "plugin_delivery_operation_invalid")
        root = SERVICE_SKILLS_DIR / report["descriptor"]["id"]
        async with component_change():
            previous = records.hil(request_id).payload.get("installation_state", {})
            try:
                snapshot = (
                    installed_snapshot(
                        root, host_version=candidates.host_version, capabilities=PLUGIN_CAPABILITIES
                    )
                    if root.exists()
                    else None
                )
                state = installation_result(
                    report,
                    previous,
                    snapshot,
                    report["descriptor"]["id"] not in load_skill_state().disabled_skills,
                )
            except (ValueError, OSError, KeyError) as exc:
                state = {"status": InstallationStatus.UNKNOWN, "error": str(exc)}
            if operation == "skip" and state["status"] not in {
                InstallationStatus.INSTALLED,
                InstallationStatus.UNKNOWN,
            }:
                state = {"status": InstallationStatus.SKIPPED}
            records.installation_state(request_id, state)
            if operation == "check" and state["status"] == InstallationStatus.UNKNOWN:
                return state
            if operation in {"check", "directory"}:
                if operation == "directory" and state["status"] == InstallationStatus.INSTALLED:
                    return {**state, "directory": str(root), "location": "installed"}
                path = question.get("installation_path")
                if not path:
                    raise HTTPException(409, "plugin_delivery_source_unavailable")
                workspace = Path(records.get(session_id).runtime_workdir)
                try:
                    read_delivery(workspace, path, report["sha256"])
                    if operation == "directory":
                        return {
                            **state,
                            "directory": str((workspace / path).parent),
                            "location": "generated",
                        }
                    fresh = catalog.installation_report(workspace, path, report["sha256"])
                    candidate = candidates.get(fresh["candidate"], fresh["sha256"])
                    candidates.entries[fresh["candidate"]] = replace(
                        candidate, delivery_request=request_id
                    )
                    return {**state, "report": fresh}
                except (ValueError, OSError) as exc:
                    raise HTTPException(409, str(exc)) from exc
            return state

    @router.post(
        "/api/capabilities/skills/plugins/check", dependencies=[Depends(require_host_process)]
    )
    async def check_plugin(file: UploadFile = File(...)) -> dict[str, Any]:
        payload = await file.read(MAX_PACKAGE_BYTES + 1)
        try:
            report = candidates.check(payload)
            if report.get("kind") == "ui":
                candidates.discard(report["candidate"])
                raise ValueError(UI_DESKTOP_DISTRIBUTION_ONLY)
            descriptor = report.get("descriptor") or {}
            return {
                **report,
                "update": (
                    components.active_ui() is not None
                    if report.get("kind") == "ui" and components is not None
                    else (
                        (SERVICE_SKILLS_DIR / str(descriptor.get("id", ""))).is_dir()
                        if descriptor.get("id")
                        else False
                    )
                ),
            }
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post(
        "/api/capabilities/skills/plugins/preview", dependencies=[Depends(require_host_process)]
    )
    async def preview_plugin(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return candidates.preview(str(body.get("candidate", "")), str(body.get("sha256", "")))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post(
        "/api/capabilities/skills/plugins/confirm", dependencies=[Depends(require_host_process)]
    )
    async def confirm_plugin(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        if body.get("confirmed") is not True:
            raise HTTPException(422, "plugin_confirmation_required")
        delivery_request = None
        try:
            grants = body.get("grants")
            if not isinstance(grants, list) or any(not isinstance(item, str) for item in grants):
                raise ValueError("plugin_consent_invalid")
            token, digest = str(body.get("candidate", "")), str(body.get("sha256", ""))
            candidate = candidates.get(token, digest)
            delivery_request = candidate.delivery_request
            if sorted(grants) != sorted(candidate.report["descriptor"]["capabilities"]):
                raise ValueError("plugin_consent_mismatch")
            enabled, update = body.get("enable", True), body.get("update", False)
            if type(enabled) is not bool or type(update) is not bool:
                raise ValueError("plugin_install_options_invalid")
            if candidate.result is not None:
                if candidate.result["enabled"] != enabled:
                    raise ValueError("plugin_consent_mismatch")
                return candidate.result
            payload = candidate.payload
            if candidate.report.get("kind") == "ui":
                raise ValueError(UI_DESKTOP_DISTRIBUTION_ONLY)
            package = read_package(payload)
            async with component_change():
                candidate = candidates.get(token, digest)
                if candidate.result is not None:
                    if candidate.result["enabled"] != enabled:
                        raise ValueError("plugin_consent_mismatch")
                    return candidate.result
                candidates.validate_dependencies(candidate)
                if delivery_request:
                    root = SERVICE_SKILLS_DIR / package.name
                    if root.exists():
                        snapshot = installed_snapshot(
                            root,
                            host_version=candidates.host_version,
                            capabilities=PLUGIN_CAPABILITIES,
                        )
                        reconciled = installation_result(
                            candidate.report,
                            {},
                            snapshot,
                            package.name not in load_skill_state().disabled_skills,
                        )
                        if reconciled["status"] != InstallationStatus.INSTALLED:
                            raise ValueError("plugin_revision_changed")
                        result = {
                            "installed": {"name": package.name},
                            "enabled": reconciled["receipt"]["enabled"],
                            "receipt": reconciled["receipt"],
                        }
                        candidates.complete(token, digest, result)
                        app.state.session_catalog.installation_state(delivery_request, reconciled)
                        return result
                    app.state.session_catalog.installation_state(
                        delivery_request, {"status": InstallationStatus.INSTALLING}
                    )
                discovered = await inventory(request, force_reload=True)
                previous = load_skill_state()
                if components is None:
                    raise HTTPException(503, "component_registry_unavailable")
                snapshots = [
                    item
                    for item in catalog.component_snapshots(discovered, previous)
                    if item["descriptor"]["id"] != package.name
                ]
                if enabled or update:
                    components.check([*snapshots, candidates.preview(token, digest)])
                state = replace_skill_state(
                    previous,
                    disabled_skills=(
                        (previous.disabled_skills - {package.name})
                        if enabled
                        else (previous.disabled_skills | {package.name})
                    ),
                    deleted_skills=previous.deleted_skills - {package.name},
                )
                try:
                    with plugin_installation(
                        payload,
                        SERVICE_SKILLS_DIR,
                        origin={
                            "kind": PLUGIN_ORIGIN_KIND,
                            "fingerprint": package.fingerprint,
                            "grants": grants,
                        },
                        update=update,
                        previous_state=skill_state_record(previous),
                        restore_state=restore_skill_state,
                    ) as installed:
                        await sync_state(state, user_id=request_user_id(request), rollback=False)
                except BaseException:
                    components.invalidate()
                    try:
                        recover_plugin_installation(
                            SERVICE_SKILLS_DIR, restore_state=restore_skill_state
                        )
                        await app.state.runtime_service.configure_skills(
                            cwd=current_workspace(),
                            state=previous,
                            user_id=request_user_id(request),
                        )
                    except BaseException as exc:
                        components.invalidate()
                        raise HTTPException(503, "component_recovery_unavailable") from exc
                    raise
                result = {
                    "installed": installed.to_dict(),
                    "enabled": enabled,
                    "receipt": {
                        "name": package.name,
                        "version": package.version,
                        "enabled": enabled,
                        "sha256": digest,
                    },
                }
                if candidate.source is not None:
                    candidates.complete(token, digest, result)
                else:
                    candidates.discard(token)
                if delivery_request:
                    app.state.session_catalog.installation_state(
                        delivery_request,
                        {"status": InstallationStatus.INSTALLED, "receipt": result["receipt"]},
                    )
                return result
        except ComponentConflict as exc:
            if delivery_request:
                app.state.session_catalog.installation_state(
                    delivery_request, {"status": InstallationStatus.FAILED, "error": str(exc)}
                )
            raise HTTPException(409, exc.detail) from exc
        except ValueError as exc:
            if delivery_request:
                app.state.session_catalog.installation_state(
                    delivery_request, {"status": InstallationStatus.FAILED, "error": str(exc)}
                )
            raise HTTPException(422, str(exc)) from exc

    @router.post(
        "/api/capabilities/skills/plugins/binding", dependencies=[Depends(require_host_process)]
    )
    async def binding_plugin(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        if components is None:
            raise HTTPException(503, "component_registry_unavailable")
        reference = body.get("reference")
        if not isinstance(reference, dict):
            raise HTTPException(422, "component_binding_invalid")
        try:
            return components.snapshot(reference, user_id=request_user_id(request))
        except ValueError as exc:
            raise HTTPException(403, str(exc)) from exc

    @router.post(
        "/api/capabilities/skills/plugins/draft", dependencies=[Depends(require_host_process)]
    )
    async def draft_plugin(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        reference, values, revision = (
            body.get("reference"),
            body.get("values"),
            body.get("expected_revision"),
        )
        if (
            not isinstance(reference, dict)
            or not isinstance(values, dict)
            or type(revision) is not int
        ):
            raise HTTPException(422, "component_draft_invalid")
        if components is None:
            raise HTTPException(503, "component_registry_unavailable")
        try:
            return components.draft(
                reference,
                session_id=str(body.get("session_id", "")),
                user_id=request_user_id(request),
                values=values,
                expected_revision=revision,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.post(
        "/api/capabilities/skills/plugins/copy", dependencies=[Depends(require_host_process)]
    )
    async def copy_plugin(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        reference, content = body.get("reference"), body.get("content")
        if not isinstance(reference, dict) or ("content" in body and not isinstance(content, dict)):
            raise HTTPException(422, "component_copy_invalid")
        if components is None:
            raise HTTPException(503, "component_registry_unavailable")
        try:
            return components.copy_content(
                reference,
                session_id=str(body.get("session_id", "")),
                user_id=request_user_id(request),
                content=content,
                expected_revision=body.get("expected_revision"),
            )
        except ValueError as exc:
            code = str(exc)
            raise HTTPException(
                (
                    409
                    if code
                    in {
                        "component_state_changed",
                        "component_binding_invalid",
                        "component_permission_denied",
                    }
                    else 422
                ),
                code,
            ) from exc

    @router.post(
        "/api/capabilities/skills/plugins/action", dependencies=[Depends(require_host_process)]
    )
    async def binding_action(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        snapshot = await binding_plugin(request, body)
        reference = body["reference"]
        try:
            components.validate(
                reference,
                session_id=snapshot["interaction"]["session_id"],
                user_id=request_user_id(request),
            )
            action = component_action(
                snapshot["descriptor"], reference["component"], str(body.get("action", ""))
            )
            if action is None:
                raise ValueError("plugin_action_undeclared")
            validate_component_value(
                action.get("input_schema", {"type": "object"}), body.get("values", {})
            )
        except ValueError as exc:
            raise HTTPException(403, str(exc)) from exc
        if action["capability"] == "navigation.skills":
            return {"navigation": "skills"}
        if action["capability"] == "skills.list":
            result = await list_skills(request)
            components.validate(
                reference,
                session_id=snapshot["interaction"]["session_id"],
                user_id=request_user_id(request),
            )
            return result
        raise HTTPException(403, "plugin_capability_unavailable")

    async def plugin_snapshot(name: str, request: Request) -> dict[str, Any]:
        discovered = await inventory(request, force_reload=True)
        state = load_skill_state()
        skill = catalog.find(discovered, state, name)
        if skill is None:
            raise HTTPException(404, "plugin_not_found")
        row = next(
            (
                row
                for row in catalog.payloads(discovered, state, user_id=request_user_id(request))
                if row["name"] == name
            ),
            None,
        )
        if row is None or not row["active"]:
            raise HTTPException(403, "plugin_not_ready")
        if name in state.disabled_skills or name in state.deleted_skills:
            raise HTTPException(403, "plugin_disabled")
        try:
            snapshot = identity_snapshot(row)
            return components.dependencies(snapshot) if components is not None else snapshot
        except (ValueError, OSError, KeyError, TypeError) as exc:
            raise HTTPException(409, "plugin_installation_invalid") from exc

    @router.get(
        "/api/capabilities/skills/{name}/plugin", dependencies=[Depends(require_host_process)]
    )
    async def open_plugin(name: str, request: Request) -> dict[str, Any]:
        return await plugin_snapshot(name, request)

    @router.post(
        "/api/capabilities/skills/{name}/plugin/action",
        dependencies=[Depends(require_host_process)],
    )
    async def plugin_action(
        name: str, request: Request, body: dict[str, Any] = Body(...)
    ) -> dict[str, Any]:
        snapshot = await plugin_snapshot(name, request)
        if body.get("fingerprint") != snapshot["fingerprint"]:
            raise HTTPException(409, "plugin_revision_changed")
        descriptor = snapshot["descriptor"]
        action = component_action(
            descriptor, str(body.get("component") or ""), str(body.get("action") or "")
        )
        if action is None:
            raise HTTPException(403, "plugin_action_undeclared")
        handlers = {
            "skills.list": lambda: list_skills(request),
        }
        if action["capability"] == "navigation.skills":
            return {"navigation": "skills"}
        handler = handlers.get(action["capability"])
        if handler is None:
            raise HTTPException(403, "plugin_capability_unavailable")
        result = await handler()
        current = await plugin_snapshot(name, request)
        if current["fingerprint"] != snapshot["fingerprint"]:
            raise HTTPException(409, "plugin_revision_changed")
        return result

    @router.post("/api/capabilities/skills/upload/preview")
    async def preview_upload(file: UploadFile = File(...)) -> dict[str, Any]:
        try:
            preview = preview_skill_upload(await file.read(), file.filename or "")
            if not preview["plugin"] and (SERVICE_SKILLS_DIR / preview["name"]).exists():
                raise SkillDuplicateError(preview["name"])
            return {"preview": preview}
        except SkillPackageError as exc:
            raise _install_error(exc) from exc

    @router.post("/api/capabilities/skills/upload")
    async def upload_skill(
        request: Request,
        file: UploadFile = File(...),
    ) -> dict[str, Any]:
        payload = await file.read(MAX_PACKAGE_BYTES + 1)
        filename = (file.filename or "").strip()
        fallback = Path(filename).stem or "skill"
        try:
            preview = preview_skill_upload(payload, filename)
            if preview["plugin"]:
                raise SkillPackageError("plugin_confirmation_required")
            if filename.lower().endswith(".zip") or payload[:2] == b"PK":
                installed = install_skill_archive(
                    payload,
                    SERVICE_SKILLS_DIR,
                    fallback_name=fallback,
                    overwrite=False,
                    include_plugin=False,
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
