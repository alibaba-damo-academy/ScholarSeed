"""Independently built UI resources and immutable dependency resolution."""

from __future__ import annotations

import base64
from copy import deepcopy
from hashlib import sha256
from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from service.capabilities.service.canvas import CanvasDocument
from service.capabilities.service.declarative import CANVAS_REVISION, CANVAS_SLOT, OPENUI_ROOT
from service.capabilities.service.descriptor import (
    HOST_COMPONENT_FINGERPRINT,
    HOST_COMPONENT_PLUGIN,
    HOST_COMPONENT_REVISION,
    MAX_DECLARATIONS,
    MAX_DESCRIPTOR_BYTES,
    PUBLIC_COMPONENT_PROVIDERS,
    PUBLIC_COMPONENT_SLOTS,
    SYSTEM_UI_PLUGIN,
    Declaration,
    PluginAction,
    UICompatibility,
    portable_resource,
)
from service.capabilities.service.package import VERSION_PATTERN, read_archive
from service.capabilities.service.utils import json_object

UI_MANIFEST = ".scholarseed-ui.json"
UI_COMPATIBILITY = "2.0"
UI_ID = SYSTEM_UI_PLUGIN
UI_RESOURCE_PREFIX = "__ui__/"
UI_SCHEMA = 1
UI_UNAVAILABLE = "ui_dependency_unavailable"
UI_INITIALIZATION_FAILED = "ui_initialization_failed"
UI_CATALOG = "catalog.json"
DECLARATIVE_CATALOG = "conversation.json"
CANVAS_CATALOG = "canvas.json"
CANVAS_SCHEMA_CATALOG = "canvas.schema.json"
UI_CATALOG_INVALID = "ui_catalog_invalid"
UI_CATALOG_UNAVAILABLE = "ui_catalog_unavailable"
UI_CATALOG_REQUIRED = "ui_catalog_required"
UI_MAX_FAMILIES = 64
UI_MAX_FAMILY_EXPORTS = 64
UI_REFERENCE_ACTIONS = {
    "open-source": "navigation.open",
    "add-reference": "literature.write",
    "collections": "literature.read",
    "create-collection": "literature.write",
}
UI_COMPONENT_ACTIONS = {
    "interaction.question": {"choose": "interaction.answer"},
    "literature.selection": {
        "select": "interaction.answer",
        "authorize": "interaction.answer",
        "reject": "interaction.answer",
    },
    "literature.authorization": {
        "authorize": "interaction.answer",
        "reject": "interaction.answer",
    },
    "display.literature-search": {
        "open-source": "navigation.open",
        "open-results": "navigation.open",
    },
    "preview.literature-results": UI_REFERENCE_ACTIONS,
}


def read_declarative_catalog(
    ui: dict[str, Any], *, canvas: bool = False, detail: str = "prompt"
) -> dict[str, Any] | None:
    filename = (
        (CANVAS_SCHEMA_CATALOG if detail == "schema" else CANVAS_CATALOG)
        if canvas
        else DECLARATIVE_CATALOG
    )
    encoded = ui["files"].get(filename)
    if encoded is None:
        return None
    catalog = json_object(base64.b64decode(encoded, validate=True), limit=MAX_DESCRIPTOR_BYTES)
    if catalog.get("host_revision") != (CANVAS_REVISION if canvas else HOST_COMPONENT_REVISION):
        return None
    if (
        catalog.get("format") != "openui-lang"
        or catalog.get("version") != 1
        or catalog.get("root") != ("Stack" if canvas else OPENUI_ROOT)
        or ((not canvas or detail == "schema") and not isinstance(catalog.get("schema"), dict))
        or ((not canvas or detail == "prompt") and not isinstance(catalog.get("prompt"), str))
        or not isinstance(catalog.get("groups"), list)
    ):
        raise ValueError(UI_CATALOG_INVALID)
    return catalog


def read_catalog(ui: dict[str, Any]) -> dict[str, Any] | None:
    encoded = ui["files"].get(UI_CATALOG)
    if encoded is None:
        if len(ui["exports"]) > UI_MAX_FAMILY_EXPORTS:
            raise ValueError(UI_CATALOG_REQUIRED)
        return None
    try:
        catalog = json_object(base64.b64decode(encoded, validate=True), limit=MAX_DESCRIPTOR_BYTES)
        if (
            catalog.get("schema") != UI_SCHEMA
            or catalog.get("grantsPermissions") is not False
            or any(
                catalog.get(key) != ui[key] for key in ("id", "version", "compatibility", "exports")
            )
            or not isinstance(catalog.get("families"), list)
            or len(catalog["families"]) > UI_MAX_FAMILIES
            or not isinstance(catalog.get("bridge"), dict)
        ):
            raise ValueError(UI_CATALOG_INVALID)
        if (
            not isinstance(catalog.get("components"), list)
            or [
                UIComponent.model_validate(component).model_dump(mode="json")
                for component in catalog["components"]
            ]
            != ui["components"]
        ):
            raise ValueError(UI_CATALOG_INVALID)
        declared: list[str] = []
        families: set[str] = set()
        for family in catalog["families"]:
            if (
                not isinstance(family, dict)
                or not isinstance(family.get("name"), str)
                or not family["name"].isidentifier()
                or family["name"] in families
                or not isinstance(family.get("exports"), list)
                or not 0 < len(family["exports"]) <= UI_MAX_FAMILY_EXPORTS
            ):
                raise ValueError(UI_CATALOG_INVALID)
            families.add(family["name"])
            for name in family["exports"]:
                if not isinstance(name, str) or name not in ui["exports"] or name in declared:
                    raise ValueError(UI_CATALOG_INVALID)
                declared.append(name)
        if set(declared) != set(ui["exports"]):
            raise ValueError(UI_CATALOG_INVALID)
        return catalog
    except (ValueError, TypeError, UnicodeError) as error:
        raise ValueError(UI_CATALOG_INVALID) from error


class UIComponent(Declaration):
    slot: str
    entry: str
    actions: list[PluginAction] = Field(max_length=MAX_DECLARATIONS)

    @model_validator(mode="after")
    def valid_component(self) -> UIComponent:
        if self.slot not in PUBLIC_COMPONENT_SLOTS:
            raise ValueError("ui_slot_unknown")
        portable_resource(self.entry)
        if not self.entry.endswith(".js"):
            raise ValueError("ui_entry_invalid")
        if len({action.id for action in self.actions}) != len(self.actions):
            raise ValueError("ui_action_duplicate")
        allowed = UI_COMPONENT_ACTIONS[self.slot]
        if any(allowed.get(action.id) != action.capability for action in self.actions):
            raise ValueError("ui_action_unsupported")
        return self


class UIDescriptor(Declaration):
    schema_version: Literal[1] = Field(alias="schema")
    id: Literal["official-ui"]
    compatibility: UICompatibility
    version: str
    runtime: str
    exports: list[str]
    components: list[UIComponent] = Field(max_length=MAX_DECLARATIONS)

    @field_validator("version")
    @classmethod
    def valid_version(cls, value: str) -> str:
        if not VERSION_PATTERN.fullmatch(value):
            raise ValueError("ui_version_invalid")
        return value

    @model_validator(mode="after")
    def valid_resources(self) -> UIDescriptor:
        portable_resource(self.runtime)
        if not self.runtime.endswith(".js"):
            raise ValueError("ui_runtime_invalid")
        if len(set(self.exports)) != len(self.exports) or any(
            not name.isidentifier() or name.startswith("_") for name in self.exports
        ):
            raise ValueError("ui_exports_invalid")
        if len({component.slot for component in self.components}) != len(self.components):
            raise ValueError("ui_slot_duplicate")
        return self


def read_ui(payload: bytes) -> dict[str, Any]:
    package = read_archive(payload)
    if UI_MANIFEST not in package.files or "SKILL.md" in package.files:
        raise ValueError("ui_manifest_required")
    descriptor = UIDescriptor.model_validate(
        json_object(package.files[UI_MANIFEST].data, limit=MAX_DESCRIPTOR_BYTES)
    )
    if descriptor.id != package.name or descriptor.version != package.version:
        raise ValueError("ui_identity_mismatch")
    for name in package.files:
        portable_resource(name)
    for name in (descriptor.runtime, *(component.entry for component in descriptor.components)):
        if name not in package.files:
            raise ValueError("ui_resource_missing")
        package.files[name].data.decode("utf-8")
    result = {
        **descriptor.model_dump(mode="json", by_alias=True),
        "fingerprint": package.fingerprint,
        "files": {
            name: base64.b64encode(item.data).decode("ascii")
            for name, item in package.files.items()
        },
    }
    read_catalog(result)
    return result


def resolve_ui(snapshot: dict[str, Any], ui: dict[str, Any] | None) -> dict[str, Any]:
    dependency = snapshot["descriptor"].get("ui")
    required = any(
        component.get("public")
        and PUBLIC_COMPONENT_PROVIDERS.get(component.get("slot")) == SYSTEM_UI_PLUGIN
        for component in snapshot["descriptor"]["components"]
    )
    if required and ui is None:
        raise ValueError(UI_UNAVAILABLE)
    public = any(
        component.get("public")
        and ui is not None
        and any(item["slot"] == component.get("slot") for item in ui["components"])
        for component in snapshot["descriptor"]["components"]
    )
    if dependency is None and not public:
        return snapshot
    if ui is None:
        raise ValueError(UI_UNAVAILABLE)
    if dependency:
        if dependency["compatibility"] != ui["compatibility"]:
            raise ValueError("ui_compatibility_mismatch")
        if not set(dependency["exports"]).issubset(ui["exports"]):
            raise ValueError("ui_export_missing")
    result = deepcopy(snapshot)
    source = result.get("source_fingerprint", result["fingerprint"])
    result["source_fingerprint"] = source
    result["fingerprint"] = (
        "sha256:" + sha256(f"{source}\n{ui['fingerprint']}".encode()).hexdigest()
    )
    result["ui"] = deepcopy(ui)
    for component in result["descriptor"]["components"]:
        if component.get("public"):
            implementation = next(
                (item for item in ui["components"] if item["slot"] == component.get("slot")), None
            )
            if implementation:
                component["entry"] = UI_RESOURCE_PREFIX + implementation["entry"]
            elif PUBLIC_COMPONENT_PROVIDERS.get(component.get("slot")) == HOST_COMPONENT_PLUGIN:
                component.pop("entry", None)
    return result


def public_snapshot(slot: str) -> dict[str, Any]:
    if slot not in PUBLIC_COMPONENT_SLOTS:
        raise ValueError("component_slot_unknown")
    components: list[dict[str, Any]] = [
        {
            "id": item,
            "slot": item,
            "public": True,
            **({"input_schema": CanvasDocument.model_json_schema()} if item == CANVAS_SLOT else {}),
            "actions": (
                [
                    {"id": action, "capability": "interaction.answer"}
                    for action in ("submit", "cancel")
                ]
                if item == CANVAS_SLOT
                else (
                    [{"id": "choose", "capability": "interaction.answer"}]
                    if item
                    in {"interaction.question", "literature.selection", "literature.outline"}
                    else []
                )
            ),
        }
        for item in (
            [CANVAS_SLOT] if slot == CANVAS_SLOT else sorted(PUBLIC_COMPONENT_SLOTS - {CANVAS_SLOT})
        )
    ]
    return {
        "descriptor": {
            "id": HOST_COMPONENT_PLUGIN,
            "version": HOST_COMPONENT_REVISION,
            "capabilities": sorted(
                {
                    action["capability"]
                    for component in components
                    for action in component["actions"]
                }
            ),
            "components": components,
        },
        "fingerprint": CANVAS_REVISION if slot == CANVAS_SLOT else HOST_COMPONENT_FINGERPRINT,
        "files": {},
        "scenarios": {},
    }
