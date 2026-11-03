"""Resolve component references from authoritative active Skill identities."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from scholarseed_runtime.contract.input import InputKind, TurnInput
from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR
from service.capabilities.service.plugins import identity_snapshot

PLUGIN_COMPONENT_STALE = "plugin_component_stale"


@dataclass(frozen=True)
class TurnSkillBinding:
    turn_id: str
    generation: int
    skill_name: str
    skill_path: str
    skill_version: str

    @classmethod
    def from_input(
        cls, turn: TurnInput, versions: Mapping[str, str], generation: int
    ) -> TurnSkillBinding | None:
        skills = [item for item in turn.items if item.kind is InputKind.SKILL]
        if len(skills) != 1 or not turn.client_user_message_id:
            return None
        selected = skills[0]
        version = versions.get(selected.name)
        if selected.path is None or not version:
            return None
        return cls(
            turn.client_user_message_id,
            generation,
            selected.name,
            str(selected.path.parent),
            version,
        )

    def current(self, turn_id: str, generation: int) -> bool:
        return self.turn_id == turn_id and self.generation == generation


def validate_reference(identity: Mapping[str, Any] | None, reference: Mapping[str, Any]) -> None:
    if identity is None:
        raise ValueError(PLUGIN_COMPONENT_STALE)
    snapshot = identity_snapshot(identity)
    if (
        snapshot["descriptor"]["id"] != reference.get("plugin")
        or snapshot["fingerprint"] != reference.get("fingerprint")
        or not any(
            component["id"] == reference.get("component")
            for component in snapshot["descriptor"]["components"]
        )
    ):
        raise ValueError(PLUGIN_COMPONENT_STALE)


def component_reference(
    identity: Mapping[str, Any], *, slot: str, skill_path: str, skill_version: str
) -> dict[str, str] | None:
    root = Path(str(identity["path"])).parent
    if root.resolve() != Path(skill_path).resolve() or identity.get("version") != skill_version:
        raise ValueError(PLUGIN_COMPONENT_STALE)
    if not (root / PLUGIN_DESCRIPTOR).is_file():
        return None
    snapshot = identity_snapshot(identity)
    matches = [
        component
        for component in snapshot["descriptor"]["components"]
        if component.get("slot") == slot
    ]
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError("plugin_component_slot_ambiguous")
    return {
        "plugin": snapshot["descriptor"]["id"],
        "component": matches[0]["id"],
        "fingerprint": snapshot["fingerprint"],
    }
