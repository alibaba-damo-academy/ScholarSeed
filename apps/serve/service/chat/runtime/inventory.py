"""Product runtime inventory ownership."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from scholarseed_runtime.contract.inventory import (
    ModelInventory,
    ModelTier,
    ModelView,
    ReasoningEffort,
    SkillAvailability,
    SkillDependency,
    SkillError,
    SkillInventory,
    SkillView,
)


def _skill_inventory_from_runtime(value: Any, *, cwd: Path) -> SkillInventory:
    """Decode the stable Gateway JSON projection for existing product skill views."""

    payload = dict(value) if isinstance(value, Mapping) else {}
    skills: list[SkillView] = []
    for item in list(payload.get("skills") or []):
        if not isinstance(item, Mapping):
            continue
        try:
            availability = SkillAvailability(str(item.get("availability") or ""))
        except ValueError:
            availability = SkillAvailability.ERROR
        skills.append(
            SkillView(
                name=str(item.get("name") or ""),
                path=Path(str(item.get("path") or "")),
                description=str(item.get("description") or ""),
                availability=availability,
                enabled=bool(item.get("enabled")),
                scope=str(item.get("scope") or ""),
                short_description=str(item.get("short_description") or ""),
                display_name=str(item.get("display_name") or ""),
                dependencies=tuple(
                    SkillDependency(
                        kind=str(dependency.get("kind") or ""),
                        value=str(dependency.get("value") or ""),
                        description=str(dependency.get("description") or ""),
                        command=str(dependency.get("command") or ""),
                        transport=str(dependency.get("transport") or ""),
                        url=str(dependency.get("url") or ""),
                    )
                    for dependency in list(item.get("dependencies") or [])
                    if isinstance(dependency, Mapping)
                ),
            )
        )
    errors = tuple(
        SkillError(
            path=Path(str(item.get("path") or cwd)),
            message=str(item.get("message") or ""),
        )
        for item in list(payload.get("errors") or [])
        if isinstance(item, Mapping)
    )
    return SkillInventory(
        cwd=Path(str(payload.get("cwd") or cwd)),
        skills=tuple(skills),
        errors=errors,
        revision=str(payload.get("revision") or ""),
    )


def _model_inventory_from_runtime(value: Any) -> ModelInventory:
    """Decode the Gateway's JSON-safe model inventory at the product boundary."""

    payload = dict(value) if isinstance(value, Mapping) else {}
    models: list[ModelView] = []
    for item in list(payload.get("models") or []):
        if not isinstance(item, Mapping):
            continue
        models.append(
            ModelView(
                model_id=str(item.get("model_id") or ""),
                model=str(item.get("model") or ""),
                display_name=str(item.get("display_name") or ""),
                description=str(item.get("description") or ""),
                is_default=bool(item.get("is_default")),
                hidden=bool(item.get("hidden")),
                default_reasoning_effort=str(item.get("default_reasoning_effort") or ""),
                input_modalities=tuple(str(row) for row in item.get("input_modalities") or ()),
                supported_reasoning_efforts=tuple(
                    ReasoningEffort(
                        value=str(row.get("value") or ""),
                        description=str(row.get("description") or ""),
                    )
                    for row in item.get("supported_reasoning_efforts") or ()
                    if isinstance(row, Mapping)
                ),
                service_tiers=tuple(
                    ModelTier(
                        tier_id=str(row.get("tier_id") or ""),
                        name=str(row.get("name") or ""),
                        description=str(row.get("description") or ""),
                    )
                    for row in item.get("service_tiers") or ()
                    if isinstance(row, Mapping)
                ),
                default_service_tier=str(item.get("default_service_tier") or ""),
                supports_personality=bool(item.get("supports_personality")),
            )
        )
    return ModelInventory(
        models=tuple(models),
        next_cursor=str(payload.get("next_cursor") or ""),
    )
