"""Shared product skill management for HTTP and the conversation bridge."""

from __future__ import annotations

import logging
import shutil
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Any

from scholarseed_runtime.contract.inventory import SkillInventory, SkillView
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
)
from service.capabilities.domain import SKILL_ERROR_IMMUTABLE, SKILL_MANIFEST_NAME
from service.capabilities.service.clawhub import (
    CLAWHUB_MODERATION_BLOCKED,
    CLAWHUB_SOURCE,
    ClawHub,
    ClawHubError,
)
from service.capabilities.service.components import ComponentConflict
from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR
from service.capabilities.service.install import (
    SkillDuplicateError,
    SkillPackageError,
    install_skill_archive,
    read_skill_origin,
    update_skill_archive,
)
from service.capabilities.service.installed import read_document
from service.capabilities.service.skills import (
    SKILL_INSTALLATION_MARKETPLACE,
    SKILL_SOURCE_BUILTIN,
    SkillCatalog,
    SkillProductState,
    load_skill_state,
    replace_skill_state,
    save_skill_state,
)
from service.paths import SERVICE_SKILLS_DIR
from service.platform.activity import Activities
from service.platform.storage import open_directory

logger = logging.getLogger(__name__)
SKILL_RUNTIME_CONFLICTS = frozenset(
    {
        RESOURCE_HOST_BUSY,
        RESOURCE_HOST_CONFIGURATION_CONFLICT,
        RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    }
)
SKILL_RUNTIME_REFUSALS = SKILL_RUNTIME_CONFLICTS | {RESOURCE_HOST_CONTEXT_REQUIRED}


def authorized() -> None:
    return None


class SkillManagementError(ValueError):
    def __init__(self, status: int, detail: Any):
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


def runtime_error(error: Exception) -> SkillManagementError:
    reason = str(getattr(error, "safe_error", "") or error)
    if reason in SKILL_RUNTIME_CONFLICTS:
        return SkillManagementError(409, reason)
    if reason == RESOURCE_HOST_CONTEXT_REQUIRED:
        return SkillManagementError(503, reason)
    return SkillManagementError(503, "codex_skill_inventory_unavailable")


def package_error(error: SkillPackageError) -> SkillManagementError:
    if isinstance(error, SkillDuplicateError):
        return SkillManagementError(
            422, {"code": "duplicate_name", "message": str(error), "name": error.skill_name}
        )
    return SkillManagementError(422, {"code": "invalid_package", "message": str(error)})


class SkillManagement:
    def __init__(
        self,
        catalog: SkillCatalog,
        runtime: Callable[[], Any],
        workspace: Callable[[], Path],
        executable: Callable[[], str],
        *,
        activities: Activities,
    ):
        self.catalog = catalog
        self.runtime = runtime
        self.workspace = workspace
        self.executable = executable
        self.activities = activities

    def current_workspace(self) -> Path:
        return self.workspace().expanduser().resolve()

    @asynccontextmanager
    async def component_change(self) -> AsyncIterator[None]:
        components = self.catalog.components
        if components is None:
            yield
            return
        async with components.mutation:
            with components.changing():
                yield

    async def inventory(
        self,
        *,
        user_id: str,
        force_reload: bool = False,
    ) -> SkillInventory:
        runtime = self.runtime()
        if runtime is None or not hasattr(runtime, "skill_inventory"):
            raise SkillManagementError(503, "codex_skill_inventory_unavailable")
        executable = self.executable()
        try:
            return await runtime.skill_inventory(
                cwd=self.current_workspace(),
                user_id=user_id,
                executable=executable,
                force_reload=force_reload,
            )
        except Exception as exc:  # noqa: BLE001 - product edge returns a safe readiness error
            logger.warning(
                "skill_inventory_failed operation=inspect failure_type=%s", type(exc).__name__
            )
            raise runtime_error(exc) from exc

    async def apply_state(
        self,
        state: SkillProductState,
        *,
        user_id: str,
        authorize: Callable[[], None] = authorized,
        rollback: bool = True,
    ) -> None:
        runtime = self.runtime()
        previous = load_skill_state()
        authorize()
        try:
            await runtime.configure_skills(
                cwd=self.current_workspace(), state=state, user_id=user_id
            )
            authorize()
        except ComponentConflict as exc:
            raise SkillManagementError(409, exc.detail) from exc
        except Exception as exc:
            if (
                rollback
                and str(getattr(exc, "safe_error", "") or exc) not in SKILL_RUNTIME_REFUSALS
            ):
                try:
                    await runtime.configure_skills(
                        cwd=self.current_workspace(), state=previous, user_id=user_id
                    )
                except BaseException:
                    if self.catalog.components is not None:
                        self.catalog.components.invalidate()
                    raise SkillManagementError(503, "component_recovery_unavailable") from exc
            if isinstance(exc, SkillManagementError):
                raise
            raise runtime_error(exc) from exc

    async def configure_installed(
        self,
        name: str,
        enabled: bool = True,
        *,
        user_id: str,
        installation_source: str | None = None,
        authorize: Callable[[], None] = authorized,
    ) -> None:
        async with self.component_change():
            state = load_skill_state()
            await self.apply_state(
                replace_skill_state(
                    state,
                    disabled_skills=(
                        state.disabled_skills - {name}
                        if enabled
                        else state.disabled_skills | {name}
                    ),
                    deleted_skills=state.deleted_skills - {name},
                    installation_sources=(
                        {**state.installation_sources, name: installation_source}
                        if installation_source is not None
                        else state.installation_sources
                    ),
                ),
                user_id=user_id,
                authorize=authorize,
            )

    async def find_skill(
        self,
        name: str,
        *,
        user_id: str,
    ) -> tuple[SkillView, SkillProductState]:
        state = load_skill_state()
        skill = self.catalog.find(
            await self.inventory(user_id=user_id, force_reload=True), state, name
        )
        if skill is None:
            raise SkillManagementError(404, f"unknown skill {name!r}")
        return skill, state

    @staticmethod
    def marketplace_error(exc: ClawHubError) -> SkillManagementError:
        return SkillManagementError(502, {"code": exc.code, "message": str(exc)})

    async def marketplace(
        self, query: str = "", cursor: str = "", label: str = "", locale: str = "en"
    ) -> dict[str, Any]:
        try:
            return await ClawHub(locale=locale).list(query=query, cursor=cursor, label=label)
        except ClawHubError as exc:
            raise self.marketplace_error(exc) from exc

    async def marketplace_detail(
        self, slug: str, version: str = "", locale: str = "en"
    ) -> dict[str, Any]:
        try:
            return await ClawHub(locale=locale).detail(slug, version)
        except ClawHubError as exc:
            raise self.marketplace_error(exc) from exc

    async def marketplace_labels(self, locale: str = "en") -> dict[str, Any]:
        try:
            return {"labels": await ClawHub(locale=locale).labels()}
        except ClawHubError as exc:
            raise self.marketplace_error(exc) from exc

    async def marketplace_install(
        self,
        slug: str,
        body: dict[str, Any],
        *,
        user_id: str,
        authorize: Callable[[], None] = authorized,
    ) -> dict[str, Any]:
        version = body.get("version")
        if not isinstance(version, str) or not version:
            raise SkillManagementError(
                422, {"code": "invalid_identity", "message": "A version is required"}
            )
        enabled = body.get("enabled", True)
        if not isinstance(enabled, bool):
            raise SkillManagementError(
                422, {"code": "invalid_preference", "message": "Enabled must be a boolean"}
            )
        try:
            hub = ClawHub()
            detail = await hub.detail(slug, version)
            if detail["moderation"] == CLAWHUB_MODERATION_BLOCKED:
                raise SkillManagementError(
                    422,
                    {
                        "code": "marketplace_blocked",
                        "message": "Skill blocked by registry moderation",
                    },
                )
            payload = await hub.download(slug, version)
            discovered = await self.inventory(user_id=user_id, force_reload=True)
            reserved_names = frozenset(
                skill.name
                for skill in discovered.skills
                if self.catalog.source(self.catalog.manifest(skill.path)) == SKILL_SOURCE_BUILTIN
            )
            authorize()
            installed = install_skill_archive(
                payload,
                SERVICE_SKILLS_DIR,
                fallback_name=slug,
                reserved_names=reserved_names,
                origin={
                    "source": CLAWHUB_SOURCE,
                    "display_name": detail.get("name", ""),
                    "description": detail.get("description", ""),
                    "provider": detail.get("provider", ""),
                    "registry": hub.base,
                    "namespace": detail["namespace"],
                    "slug": slug,
                    "version": version,
                },
            )
        except ClawHubError as exc:
            raise self.marketplace_error(exc) from exc
        except SkillPackageError as exc:
            raise package_error(exc) from exc
        try:
            await self.configure_installed(
                installed.name,
                enabled,
                installation_source=SKILL_INSTALLATION_MARKETPLACE,
                user_id=user_id,
                authorize=authorize,
            )
        except Exception:
            shutil.rmtree(installed.path)
            raise
        return {"installed": installed.to_dict()}

    def installed_skills(
        self, state: SkillProductState, user_id: str, surface: str | None, locale: str | None
    ) -> tuple[SkillInventory, list[dict[str, Any]]]:
        discovered = self.catalog.installed_inventory(self.current_workspace())
        rows = self.catalog.payloads(
            discovered, state, surface=surface, user_id=user_id, locale=locale
        )
        for row in rows:
            row["runtime_enabled"] = None
            row["plugin"] = (Path(row["path"]).parent / PLUGIN_DESCRIPTOR).is_file()
        return discovered, rows

    async def list_skills(
        self, user_id: str, surface: str | None = None, locale: str | None = None
    ) -> dict[str, Any]:
        if surface is not None and not self.catalog.supports_surface(surface):
            raise SkillManagementError(422, "unknown_skill_surface")
        state = load_skill_state()
        discovered, rows = await self.activities.observe_thread(
            self.installed_skills, state, user_id, surface, locale
        )
        if locale is not None:
            try:
                rows = await ClawHub(locale=locale).enrich_local(rows)
            except ClawHubError as exc:
                raise self.marketplace_error(exc) from exc
        return {
            "skills": rows,
            "system_ui": (
                self.catalog.components.ui_status() if self.catalog.components is not None else None
            ),
            "revision": discovered.revision,
            "cwd": str(discovered.cwd),
            "errors": [
                {"path": str(error.path), "message": error.message} for error in discovered.errors
            ],
        }

    async def update_skill(
        self,
        name: str,
        body: dict[str, Any],
        *,
        user_id: str,
        authorize: Callable[[], None] = authorized,
    ) -> dict[str, Any]:
        version, expected_version = body.get("version"), body.get("expectedVersion")
        if (
            not isinstance(version, str)
            or not version
            or not isinstance(expected_version, str)
            or not expected_version
        ):
            raise SkillManagementError(
                422,
                {
                    "code": "invalid_identity",
                    "message": "Installed and offered versions are required",
                },
            )
        skill, _state = await self.find_skill(name, user_id=user_id)
        manifest = self.catalog.manifest(skill.path)
        if manifest.parent != SERVICE_SKILLS_DIR / name or self.catalog.source(manifest) != "user":
            raise SkillManagementError(
                403,
                {
                    "code": "immutable_skill",
                    "message": "Only installed marketplace skills can be updated",
                },
            )
        try:
            origin = read_skill_origin(SERVICE_SKILLS_DIR, name)
            hub = ClawHub()
            if (
                not isinstance(origin, dict)
                or origin.get("source") != CLAWHUB_SOURCE
                or str(origin.get("registry", "")).rstrip("/") not in hub.registry_aliases
                or origin.get("version") != expected_version
            ):
                raise SkillManagementError(
                    409,
                    {
                        "code": "skill_changed",
                        "message": "Installed skill identity changed; check for updates again",
                    },
                )
            slug = origin.get("slug")
            if not isinstance(slug, str):
                raise SkillPackageError("Missing marketplace identity")
            detail = await hub.detail(slug)
            if detail["namespace"] != origin.get("namespace") or detail["version"] != version:
                raise SkillManagementError(
                    409,
                    {
                        "code": "skill_changed",
                        "message": "Marketplace version changed; check for updates again",
                    },
                )
            if detail["moderation"] == CLAWHUB_MODERATION_BLOCKED:
                raise SkillManagementError(
                    422,
                    {
                        "code": "marketplace_blocked",
                        "message": "Skill blocked by registry moderation",
                    },
                )
            payload = await hub.download(slug, version)
            authorize()
            installed = update_skill_archive(
                payload,
                SERVICE_SKILLS_DIR,
                name=name,
                expected_origin=origin,
                origin={
                    **origin,
                    "version": version,
                    "registry": hub.base,
                    "display_name": detail.get("name", ""),
                    "description": detail.get("description", ""),
                    "provider": detail.get("provider", ""),
                },
            )
        except ClawHubError as exc:
            raise self.marketplace_error(exc) from exc
        except SkillManagementError:
            raise
        except (SkillPackageError, OSError, ValueError) as exc:
            raise package_error(SkillPackageError(str(exc))) from exc
        runtime = self.runtime()
        runtime.invalidate_skill_inventory(cwd=self.current_workspace())
        return {"installed": installed.to_dict()}

    async def activate_skill(
        self, name: str, *, user_id: str, authorize: Callable[[], None] = authorized
    ) -> dict[str, Any]:
        async with self.component_change():
            _skill, state = await self.find_skill(name, user_id=user_id)
            await self.apply_state(
                replace_skill_state(
                    state,
                    disabled_skills=state.disabled_skills - {name},
                    deleted_skills=state.deleted_skills - {name},
                ),
                user_id=user_id,
                authorize=authorize,
            )
            return {"name": name, "active": True}

    async def deactivate_skill(
        self, name: str, *, user_id: str, authorize: Callable[[], None] = authorized
    ) -> dict[str, Any]:
        async with self.component_change():
            skill, state = await self.find_skill(name, user_id=user_id)
            if not self.catalog.toggleable(skill):
                raise SkillManagementError(
                    409,
                    {
                        "code": SKILL_ERROR_IMMUTABLE,
                        "message": "产品必需技能始终开启，不可关闭",
                        "name": name,
                    },
                )
            await self.apply_state(
                replace_skill_state(state, disabled_skills=state.disabled_skills | {name}),
                user_id=user_id,
                authorize=authorize,
            )
            return {"name": name, "active": False}

    async def skill_document(
        self,
        name: str,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        skill = self.catalog.find(
            self.catalog.installed_inventory(self.current_workspace()), load_skill_state(), name
        )
        if skill is None:
            raise SkillManagementError(404, f"unknown skill {name!r}")
        # Installed discovery already returns a manifest path. Resolving it here
        # would follow a link swapped in after discovery, bypassing no-follow IO.
        manifest = skill.path
        try:
            with closing(open_directory(manifest.parent, ())) as directory:
                document = read_document(directory, SKILL_MANIFEST_NAME)
        except (OSError, ValueError) as exc:
            raise SkillManagementError(422, f"cannot read {SKILL_MANIFEST_NAME}: {exc}") from exc
        return {"name": name, "path": str(manifest), "document": document}

    async def delete_skill(
        self, name: str, *, user_id: str, authorize: Callable[[], None] = authorized
    ) -> dict[str, Any]:
        async with self.component_change():
            skill, state = await self.find_skill(name, user_id=user_id)
            manifest = self.catalog.manifest(skill.path).expanduser().resolve()
            source = self.catalog.source(manifest)
            if not self.catalog.removable(manifest):
                raise SkillManagementError(403, "内置技能不可删除")
            await self.apply_state(
                replace_skill_state(
                    state,
                    deleted_skills=state.deleted_skills | {name},
                    disabled_skills=state.disabled_skills | {name},
                    installation_sources={
                        key: value
                        for key, value in state.installation_sources.items()
                        if key != name
                    },
                ),
                user_id=user_id,
                authorize=authorize,
            )
            if source == "user":
                shutil.rmtree(manifest.parent)
                runtime = self.runtime()
                if runtime is not None and hasattr(runtime, "invalidate_skill_inventory"):
                    runtime.invalidate_skill_inventory(cwd=self.current_workspace())
        return {"name": name, "deleted": True}
