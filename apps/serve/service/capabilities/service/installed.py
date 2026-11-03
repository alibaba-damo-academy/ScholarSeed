"""Read product-owned installed metadata without acquiring an execution host.

This catalogue describes local packages, not native execution admission. The latter
still refreshes App Server inventory and applies the current account's skill policy.
"""

from __future__ import annotations

import json
import os
from contextlib import closing
from hashlib import sha256
from pathlib import Path

import yaml

from scholarseed_runtime.contract.inventory import (
    SkillAvailability,
    SkillDependency,
    SkillError,
    SkillInventory,
    SkillView,
)
from service.capabilities.domain import SKILL_MANIFEST_NAME
from service.capabilities.service.install import (
    MAX_DOCUMENT_BYTES,
    SKILL_NAME_PATTERN,
    parse_skill_frontmatter,
)
from service.platform.storage import DirectoryHandle, filesystem_path, open_directory

SKILL_INTERFACE_DIRECTORY = "agents"
SKILL_INTERFACE_NAME = "openai.yaml"
INSTALLED_SKILL_ERROR = "installed_skill_metadata_invalid"


def read_document(directory: DirectoryHandle, name: str) -> str:
    with os.fdopen(directory.open_regular(name), "rb") as stream:
        content = stream.read(MAX_DOCUMENT_BYTES + 1)
    if len(content) > MAX_DOCUMENT_BYTES:
        raise ValueError(INSTALLED_SKILL_ERROR)
    return content.decode("utf-8")


def installed_skill(directory: DirectoryHandle) -> SkillView:
    front, _body = parse_skill_frontmatter(read_document(directory, SKILL_MANIFEST_NAME))
    name, description = front.get("name"), front.get("description")
    if not isinstance(name, str) or not SKILL_NAME_PATTERN.fullmatch(name.strip()):
        raise ValueError(INSTALLED_SKILL_ERROR)
    if not isinstance(description, str) or not description.strip():
        raise ValueError(INSTALLED_SKILL_ERROR)
    try:
        with closing(directory.directory(SKILL_INTERFACE_DIRECTORY)) as agents:
            definition = yaml.safe_load(read_document(agents, SKILL_INTERFACE_NAME)) or {}
    except FileNotFoundError:
        definition = {}
    if not isinstance(definition, dict):
        raise ValueError(INSTALLED_SKILL_ERROR)
    interface = definition.get("interface") or {}
    dependencies = definition.get("dependencies") or {}
    if not isinstance(interface, dict) or not isinstance(dependencies, dict):
        raise ValueError(INSTALLED_SKILL_ERROR)
    tools = dependencies.get("tools") or []
    if not isinstance(tools, list) or any(
        not isinstance(row, dict)
        or not isinstance(row.get("type"), str)
        or not isinstance(row.get("value"), str)
        or not row["type"].strip()
        or not row["value"].strip()
        for row in tools
    ):
        raise ValueError(INSTALLED_SKILL_ERROR)
    return SkillView(
        name=name.strip(),
        path=directory.path / SKILL_MANIFEST_NAME,
        description=description.strip(),
        enabled=True,
        availability=SkillAvailability.AVAILABLE,
        display_name=str(interface.get("display_name") or ""),
        short_description=str(interface.get("short_description") or ""),
        dependencies=tuple(
            SkillDependency(
                kind=row["type"],
                value=row["value"],
                description=str(row.get("description") or ""),
                command=str(row.get("command") or ""),
                transport=str(row.get("transport") or ""),
                url=str(row.get("url") or ""),
            )
            for row in tools
        ),
    )


def installed_inventory(bundled_root: Path, user_root: Path, cwd: Path) -> SkillInventory:
    skills: list[SkillView] = []
    errors: list[SkillError] = []
    for root in (bundled_root, user_root):
        try:
            with closing(open_directory(root, ())) as parent:
                for entry in sorted(filesystem_path(root).iterdir()):
                    # Installers publish a flat directory per portable skill name.
                    if not SKILL_NAME_PATTERN.fullmatch(entry.name):
                        continue
                    try:
                        with closing(parent.directory(entry.name)) as directory:
                            skills.append(installed_skill(directory))
                    except (OSError, ValueError, yaml.YAMLError):
                        errors.append(
                            SkillError(
                                root / entry.name / SKILL_MANIFEST_NAME, INSTALLED_SKILL_ERROR
                            )
                        )
        except FileNotFoundError:
            if root == bundled_root:
                errors.append(SkillError(root, INSTALLED_SKILL_ERROR))
        except OSError:
            errors.append(SkillError(root, INSTALLED_SKILL_ERROR))
    revision = sha256(
        json.dumps(
            [skills, errors],
            default=str,
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    return SkillInventory(cwd=cwd, skills=tuple(skills), errors=tuple(errors), revision=revision)
