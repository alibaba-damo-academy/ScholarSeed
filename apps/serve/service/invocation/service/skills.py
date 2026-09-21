"""Canonical Skill admission for isolated single-turn invocations."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from scholarseed_runtime.contract import RuntimePermissionMode
from service.capabilities.service.skills import (
    SKILL_INVOCATION_METADATA_KEY,
    SKILL_INVOCATION_PERMISSION_DEFAULT,
    SKILL_INVOCATION_PERMISSION_FULL_ACCESS,
    SKILL_INVOCATION_PERMISSION_KEY,
    SKILL_INVOCATION_POLICY_FIELDS,
    SKILL_INVOCATION_PROFILE_FIELDS,
    SKILL_INVOCATION_PROFILES_KEY,
    SkillCatalog,
    load_skill_state,
)
from service.chat.runtime.composition import LiveSessionService
from service.chat.service.settings import SettingsService

SKILL_NOT_FOUND = "invocation_skill_not_found"
SKILL_UNAVAILABLE = "invocation_skill_unavailable"
SKILL_RUNTIME_UNAVAILABLE = "invocation_runtime_unavailable"


class InvocationSkillError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class InvocationSkillRuntimeError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(SKILL_RUNTIME_UNAVAILABLE)
        self.code = SKILL_RUNTIME_UNAVAILABLE


@dataclass(frozen=True)
class ResolvedSkill:
    id: str
    name: str
    version: str
    fingerprint: str
    path: Path
    profile: str | None
    permission_mode: RuntimePermissionMode | None


def _permission_mode(row: Mapping[str, Any], profile: str | None) -> RuntimePermissionMode | None:
    raw = row.get(SKILL_INVOCATION_METADATA_KEY)
    if raw is None and profile is None:
        return None
    if not bool(row.get("builtin")):
        if profile is not None:
            raise InvocationSkillError(SKILL_UNAVAILABLE)
        return None
    if not isinstance(raw, Mapping):
        raise InvocationSkillError(SKILL_UNAVAILABLE)
    if profile is None:
        if (
            set(raw) != SKILL_INVOCATION_POLICY_FIELDS
            or raw.get(SKILL_INVOCATION_PERMISSION_KEY) != SKILL_INVOCATION_PERMISSION_FULL_ACCESS
        ):
            raise InvocationSkillError(SKILL_UNAVAILABLE)
        return RuntimePermissionMode.BYPASS
    if set(raw) != SKILL_INVOCATION_PROFILE_FIELDS:
        raise InvocationSkillError(SKILL_UNAVAILABLE)
    profiles = raw.get(SKILL_INVOCATION_PROFILES_KEY)
    policy = profiles.get(profile) if isinstance(profiles, Mapping) else None
    if not isinstance(policy, Mapping) or set(policy) != SKILL_INVOCATION_POLICY_FIELDS:
        raise InvocationSkillError(SKILL_UNAVAILABLE)
    permission = policy.get(SKILL_INVOCATION_PERMISSION_KEY)
    if permission == SKILL_INVOCATION_PERMISSION_DEFAULT:
        return None
    if permission == SKILL_INVOCATION_PERMISSION_FULL_ACCESS:
        return RuntimePermissionMode.BYPASS
    raise InvocationSkillError(SKILL_UNAVAILABLE)


class InvocationSkillResolver:
    def __init__(
        self,
        runtime: LiveSessionService,
        settings: SettingsService,
        catalog: SkillCatalog,
    ) -> None:
        self._runtime = runtime
        self._settings = settings
        self._catalog = catalog

    async def resolve(
        self,
        *,
        skill_id: str,
        profile: str | None = None,
        cwd: Path,
        process_environment: Mapping[str, str],
        user_id: str = "",
    ) -> ResolvedSkill:
        try:
            inventory = await self._runtime.skill_inventory(
                cwd=cwd,
                executable=self._settings.runtime_executable(),
                process_environment=process_environment,
                force_reload=True,
            )
        except Exception as error:
            raise InvocationSkillRuntimeError() from error
        rows = self._catalog.payloads(inventory, load_skill_state(), user_id=user_id)
        row = next((item for item in rows if str(item.get("id") or "") == skill_id), None)
        if row is None:
            raise InvocationSkillError(SKILL_NOT_FOUND)
        if not bool(row.get("active")):
            raise InvocationSkillError(SKILL_UNAVAILABLE)
        path = Path(str(row.get("path") or "")).expanduser().resolve()
        if not path.is_file():
            raise InvocationSkillError(SKILL_NOT_FOUND)
        return ResolvedSkill(
            id=skill_id,
            name=str(row.get("name") or ""),
            version=str(row.get("version") or ""),
            fingerprint=str(row.get("fingerprint") or ""),
            path=path,
            profile=profile,
            permission_mode=_permission_mode(row, profile),
        )


__all__ = [
    "InvocationSkillError",
    "InvocationSkillRuntimeError",
    "InvocationSkillResolver",
    "ResolvedSkill",
    "SKILL_NOT_FOUND",
    "SKILL_RUNTIME_UNAVAILABLE",
    "SKILL_UNAVAILABLE",
]
