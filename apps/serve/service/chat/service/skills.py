"""Codex skill inventory projected through the shared ScholarSeed catalog."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from scholarseed_runtime.contract.inventory import SkillInventory
from service.capabilities.service.skills import SkillCatalog, load_skill_state
from service.chat.runtime.composition import LiveSessionService
from service.chat.service.settings import SettingsService

SKILL_DOCUMENT_FILENAME = "SKILL.md"
SKILL_DOCUMENT_MAX_BYTES = 512 * 1024


class SkillService:
    """Read the official runtime inventory and enrich it with product metadata."""

    def __init__(
        self,
        *,
        runtime_id: str,
        cwd: Path,
        runtime: LiveSessionService,
        settings: SettingsService,
        catalog: SkillCatalog,
    ) -> None:
        self.runtime_id = runtime_id
        self.cwd = cwd.expanduser().resolve()
        self._runtime = runtime
        self._settings = settings
        self._catalog = catalog

    async def inventory(
        self,
        *,
        user_id: str,
        force_reload: bool = False,
        process_environment: Mapping[str, str] | None = None,
    ) -> SkillInventory:
        return await self._runtime.skill_inventory(
            cwd=self.cwd,
            user_id=user_id,
            executable=self._settings.runtime_executable(),
            process_environment=process_environment,
            force_reload=force_reload,
        )

    async def payload(
        self,
        *,
        force_reload: bool = False,
        process_environment: Mapping[str, str] | None = None,
        user_id: str = "",
    ) -> dict[str, Any]:
        inventory = await self.inventory(
            user_id=user_id,
            force_reload=force_reload,
            process_environment=process_environment,
        )
        projected = self._catalog.payloads(
            SkillInventory(
                cwd=inventory.cwd,
                skills=inventory.skills,
                errors=inventory.errors,
                revision=inventory.revision,
            ),
            load_skill_state(),
            user_id=user_id,
        )
        return {
            "runtime_id": self.runtime_id,
            "cwd": str(inventory.cwd),
            "revision": inventory.revision,
            "skills": projected,
            "errors": [
                {"path": str(error.path), "message": error.message} for error in inventory.errors
            ],
        }

    async def document(
        self,
        name: str,
        *,
        user_id: str,
        process_environment: Mapping[str, str] | None = None,
    ) -> str | None:
        inventory = await self.inventory(user_id=user_id, process_environment=process_environment)
        skill = self._catalog.find(inventory, load_skill_state(), name)
        if skill is None:
            return None
        document = self._catalog.manifest(skill.path).expanduser().resolve()
        if not document.is_file() or document.stat().st_size > SKILL_DOCUMENT_MAX_BYTES:
            return None
        return document.read_text("utf-8")

    async def aclose(self) -> None:
        """Runtime controls are request-scoped and closed by LiveSessionService."""


__all__ = ["SkillService"]
