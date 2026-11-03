"""Codex App Server skill inventory projected through the surface port."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_codex.utils import path_identity
from scholarseed_runtime.contract.command import SkillConfiguration
from scholarseed_runtime.contract.event import RuntimeValue
from scholarseed_runtime.contract.inventory import (
    SkillAvailability,
    SkillDependency,
    SkillError,
    SkillInventory,
    SkillView,
)

CODEX_SKILLS_LIST_METHOD = "skills/list"
CODEX_SKILLS_CONFIGURE_METHOD = "skills/config/write"
CODEX_SKILL_INVENTORY_ERROR = "codex_skill_inventory_error"
SKILL_REVISION_ENCODING = "utf-8"
CODEX_SKILLS_CONFIG_KEY = "skills"
CODEX_SKILL_RULES_KEY = "config"
CODEX_SKILL_PATH_KEY = "path"
CODEX_SKILL_ENABLED_KEY = "enabled"

RequestCallback = Callable[[str, Any], Awaitable[dict[str, Any]]]


def session_skill_config(
    configurations: tuple[SkillConfiguration, ...],
) -> dict[str, RuntimeValue]:
    if not configurations:
        return {}
    return {
        CODEX_SKILLS_CONFIG_KEY: {
            CODEX_SKILL_RULES_KEY: [
                {
                    CODEX_SKILL_PATH_KEY: str(configuration.path.expanduser().resolve()),
                    CODEX_SKILL_ENABLED_KEY: configuration.enabled,
                }
                for configuration in configurations
            ]
        }
    }


def session_skill_inventory(
    inventory: SkillInventory, configurations: tuple[SkillConfiguration, ...]
) -> SkillInventory:
    if not configurations:
        return inventory
    enabled_by_path = {
        path_identity(configuration.path): configuration.enabled for configuration in configurations
    }
    skills = tuple(
        (
            replace(
                skill,
                enabled=enabled_by_path[path_identity(skill.path)],
                availability=(
                    SkillAvailability.AVAILABLE
                    if enabled_by_path[path_identity(skill.path)]
                    else SkillAvailability.DISABLED
                ),
            )
            if path_identity(skill.path) in enabled_by_path
            and skill.availability is not SkillAvailability.ERROR
            else skill
        )
        for skill in inventory.skills
    )
    revision_payload = json.dumps(
        [inventory.revision, session_skill_config(configurations)], sort_keys=True
    )
    revision = hashlib.sha256(revision_payload.encode(SKILL_REVISION_ENCODING)).hexdigest()
    return replace(inventory, skills=skills, revision=revision)


class CodexSkillControl:
    """Translate the 0.147 skill inventory without leaking vendor records."""

    def __init__(self, *, request: RequestCallback, cwd: Path) -> None:
        self._request = request
        self._cwd = cwd.expanduser().resolve()

    async def list_skills(
        self,
        *,
        cwd: Path | None = None,
        force_reload: bool = False,
    ) -> SkillInventory:
        selected_cwd = (cwd or self._cwd).expanduser().resolve()
        result = await self._request(
            CODEX_SKILLS_LIST_METHOD,
            {"cwds": [str(selected_cwd)], "forceReload": force_reload},
        )
        entry = next(
            (
                dict(row)
                for row in list(result.get("data") or [])
                if str(row.get("cwd") or "") == str(selected_cwd)
            ),
            {},
        )
        errors = tuple(
            SkillError(
                path=Path(str(row.get("path") or selected_cwd)),
                message=CODEX_SKILL_INVENTORY_ERROR,
            )
            for row in list(entry.get("errors") or [])
            if isinstance(row, Mapping)
        )
        skills = tuple(
            self._skill_view(row)
            for row in list(entry.get("skills") or [])
            if isinstance(row, Mapping)
        )
        revision_payload = json.dumps(entry, ensure_ascii=False, sort_keys=True, default=str)
        revision = hashlib.sha256(revision_payload.encode(SKILL_REVISION_ENCODING)).hexdigest()
        return SkillInventory(
            cwd=selected_cwd,
            skills=skills,
            errors=errors,
            revision=revision,
        )

    async def configure(self, path: Path, enabled: bool) -> None:
        result = await self._request(
            CODEX_SKILLS_CONFIGURE_METHOD,
            {"path": str(path.expanduser().resolve()), "enabled": enabled},
        )
        if result.get("effectiveEnabled") is not enabled:
            raise RuntimeError("codex skill enablement was not applied")

    @staticmethod
    def _skill_view(raw: Mapping[str, Any]) -> SkillView:
        enabled = bool(raw.get("enabled"))
        interface = dict(raw.get("interface") or {})
        dependencies = dict(raw.get("dependencies") or {})
        return SkillView(
            name=str(raw.get("name") or ""),
            path=Path(str(raw.get("path") or "")),
            description=str(raw.get("description") or ""),
            availability=(SkillAvailability.AVAILABLE if enabled else SkillAvailability.DISABLED),
            enabled=enabled,
            scope=str(raw.get("scope") or ""),
            short_description=str(
                interface.get("shortDescription") or raw.get("shortDescription") or ""
            ),
            display_name=str(interface.get("displayName") or ""),
            dependencies=tuple(
                SkillDependency(
                    kind=str(row.get("type") or ""),
                    value=str(row.get("value") or ""),
                    description=str(row.get("description") or ""),
                    command=str(row.get("command") or ""),
                    transport=str(row.get("transport") or ""),
                    url=str(row.get("url") or ""),
                )
                for row in list(dependencies.get("tools") or [])
                if isinstance(row, Mapping)
            ),
        )


__all__ = ["CodexSkillControl", "session_skill_config", "session_skill_inventory"]
