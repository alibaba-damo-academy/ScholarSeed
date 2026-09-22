"""Durable project registry for the ScholarSeed chat product."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from service.paths import SERVICE_PROJECTS_FILE

PROJECTS_KEY = "projects"
TEMP_SUFFIX = ".tmp"


class ProjectRegistry:
    """Persist explicit user projects without treating the default workspace as one."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or SERVICE_PROJECTS_FILE)

    def load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {PROJECTS_KEY: []}
        if not isinstance(value, dict):
            return {PROJECTS_KEY: []}
        raw_projects = value.get(PROJECTS_KEY)
        projects = [dict(row) for row in raw_projects or () if isinstance(row, dict)]
        return {PROJECTS_KEY: projects}

    def save(self, value: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + TEMP_SUFFIX)
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    def projects(self) -> list[dict[str, Any]]:
        return list(self.load()[PROJECTS_KEY])

    def contains(self, path: Path) -> bool:
        target = str(path.expanduser().resolve())
        return any(str(row.get("path") or "") == target for row in self.projects())

    def add(self, path: Path, name: str) -> dict[str, Any]:
        resolved = str(path.expanduser().resolve())
        value = self.load()
        entry = next(
            (row for row in value[PROJECTS_KEY] if str(row.get("path") or "") == resolved),
            None,
        )
        if entry is None:
            entry = {"name": name, "path": resolved, "added_at": int(time.time())}
            value[PROJECTS_KEY].append(entry)
            self.save(value)
        return dict(entry)

    def rename(self, path: Path, name: str) -> dict[str, Any] | None:
        resolved = str(path.expanduser().resolve())
        value = self.load()
        entry = next(
            (row for row in value[PROJECTS_KEY] if str(row.get("path") or "") == resolved),
            None,
        )
        if entry is None:
            return None
        entry["name"] = name
        self.save(value)
        return dict(entry)

    def remove(self, path: Path) -> bool:
        resolved = str(path.expanduser().resolve())
        value = self.load()
        remaining = [row for row in value[PROJECTS_KEY] if str(row.get("path") or "") != resolved]
        if len(remaining) == len(value[PROJECTS_KEY]):
            return False
        value[PROJECTS_KEY] = remaining
        self.save(value)
        return True


__all__ = ["ProjectRegistry"]
