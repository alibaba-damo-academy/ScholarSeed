"""Verified installed plugin snapshots from the existing Skill installation root."""

from __future__ import annotations

import base64
import io
import zipfile
from importlib.metadata import version
from pathlib import Path
from typing import Any, Mapping

from service.capabilities.service.descriptor import inspect_plugin
from service.capabilities.service.install import MAX_UNCOMPRESSED_BYTES, ORIGIN_FILE_NAME
from service.capabilities.service.package import (
    MAX_FILE_BYTES,
    MAX_FILES,
    PACKAGE_MANIFEST,
    read_package,
    safe_path,
)
from service.capabilities.service.utils import json_object

PLUGIN_ORIGIN_KIND = "local-plugin"
PLUGIN_CAPABILITIES = (
    "skills.list",
    "navigation.skills",
    "interaction.answer",
    "literature.read",
    "literature.write",
    "navigation.open",
)
PLUGIN_DISTRIBUTION = "scholarseed"
PLUGIN_BUILTIN_SOURCE = "builtin"
PLUGIN_USER_SOURCE = "user"
PLUGIN_SELECTION_SLOT = "literature.selection"
PLUGIN_AUTHORIZATION_SLOT = "literature.authorization"
PLUGIN_OUTLINE_SLOT = "literature.outline"
PLUGIN_QUESTION_SLOT = "interaction.question"
PLUGIN_DISPLAY_PREFIX = "display."


def component_action(
    descriptor: Mapping[str, Any], component_id: str, action_id: str
) -> Mapping[str, Any] | None:
    component = next(
        (item for item in descriptor["components"] if item["id"] == component_id), None
    )
    if component is None:
        return None
    return next(
        (
            action
            for action in component["actions"]
            if action["id"] == action_id and action["capability"] in descriptor["capabilities"]
        ),
        None,
    )


def installed_snapshot(
    root: Path, *, host_version: str, capabilities: tuple[str, ...], bundled: bool = False
) -> dict[str, Any]:
    if root.is_symlink() or root.is_junction():
        raise ValueError("plugin_link_rejected")
    manifest_path = root / PACKAGE_MANIFEST
    if manifest_path.is_symlink() or manifest_path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("plugin_manifest_invalid")
    manifest = json_object(manifest_path.read_bytes(), limit=MAX_FILE_BYTES)
    rows = manifest["files"]
    if not isinstance(rows, list) or len(rows) > MAX_FILES:
        raise ValueError("plugin_manifest_invalid")
    total = 0
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in [PACKAGE_MANIFEST, *(row["path"] for row in manifest["files"])]:
            safe_path(name)
            path = root / name
            if any(
                part.is_symlink() or part.is_junction()
                for part in (path, *path.parents)
                if part != root.parent
            ):
                raise ValueError("plugin_link_rejected")
            if path.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("plugin_file_oversized")
            total += path.stat().st_size
            if total > MAX_UNCOMPRESSED_BYTES:
                raise ValueError("plugin_package_oversized")
            archive.writestr(name, path.read_bytes())
    package = read_package(buffer.getvalue())
    report = inspect_plugin(
        {name: item.data for name, item in package.files.items()},
        skill_name=package.name,
        skill_version=package.version,
        host_version=host_version,
        available_capabilities=capabilities,
    )
    if not report["valid"]:
        raise ValueError("plugin_contract_incompatible")
    if not bundled:
        _verify_origin(root, package.fingerprint, report["descriptor"]["capabilities"])
    return {
        "descriptor": report["descriptor"],
        "scenarios": report["scenarios"],
        "fingerprint": package.fingerprint,
        "files": {
            name: base64.b64encode(item.data).decode("ascii")
            for name, item in package.files.items()
        },
    }


def _verify_origin(root: Path, fingerprint: str, grants: list[str]) -> None:
    origin_path = root / ORIGIN_FILE_NAME
    if origin_path.is_symlink() or origin_path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("plugin_origin_invalid")
    origin = json_object(origin_path.read_bytes(), limit=MAX_FILE_BYTES)
    if origin.get("kind") != PLUGIN_ORIGIN_KIND or origin.get("fingerprint") != fingerprint:
        raise ValueError("plugin_installation_changed")
    if sorted(origin.get("grants", [])) != sorted(grants):
        raise ValueError("plugin_consent_changed")


def identity_snapshot(identity: Mapping[str, Any]) -> dict[str, Any]:
    if not identity.get("active") or identity.get("source") not in {
        PLUGIN_BUILTIN_SOURCE,
        PLUGIN_USER_SOURCE,
    }:
        raise ValueError("plugin_not_active")
    return installed_snapshot(
        Path(str(identity["path"])).parent,
        host_version=version(PLUGIN_DISTRIBUTION),
        capabilities=PLUGIN_CAPABILITIES,
        bundled=identity["source"] == PLUGIN_BUILTIN_SOURCE,
    )
