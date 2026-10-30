"""Durable project registry for the ScholarSeed chat product."""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from service.paths import SERVICE_PROJECTS_FILE

PROJECTS_KEY = "projects"
TEMP_SUFFIX = ".tmp"
PROJECTS_INVALID_FORMAT_ERROR = "projects_invalid_format"


class ProjectRegistry:
    """Persist explicit user projects without treating the default workspace as one."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or SERVICE_PROJECTS_FILE)

    def load(self) -> dict[str, Any]:
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            raw = None
        return self.decode(raw)

    @staticmethod
    def decode(raw: bytes | None) -> dict[str, Any]:
        """Decode bytes from the normal reader or a held native directory."""
        if raw is None:
            return {PROJECTS_KEY: []}
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError(PROJECTS_INVALID_FORMAT_ERROR) from error
        if not isinstance(value, dict) or not isinstance(value.get(PROJECTS_KEY), list):
            raise ValueError(PROJECTS_INVALID_FORMAT_ERROR)
        for row in value[PROJECTS_KEY]:
            if not isinstance(row, dict):
                raise ValueError(PROJECTS_INVALID_FORMAT_ERROR)
            path = row.get("path")
            if (
                not isinstance(path, str)
                or not path.strip()
                or "\0" in path
                or not Path(path.strip()).is_absolute()
                or not isinstance(row.get("name", ""), str)
            ):
                raise ValueError(PROJECTS_INVALID_FORMAT_ERROR)
        return value

    def save(self, value: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(
            prefix=self.path.name + ".", suffix=TEMP_SUFFIX, dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(self.encode(value).decode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass

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
        value = self.load()
        if not self.remove_entry(value, path):
            return False
        self.save(value)
        return True

    @staticmethod
    def encode(value: dict[str, Any]) -> bytes:
        return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        )

    @staticmethod
    def remove_entry(value: dict[str, Any], path: Path) -> bool:
        """Shared removal transition; caller owns qualification of resolved paths."""
        resolved = str(path.expanduser().resolve())
        remaining = [
            row
            for row in value[PROJECTS_KEY]
            if str(Path(row["path"].strip()).expanduser().resolve()) != resolved
        ]
        if len(remaining) == len(value[PROJECTS_KEY]):
            return False
        value[PROJECTS_KEY] = remaining
        return True

    @classmethod
    def preview_removals(cls, raw: bytes | None, paths: tuple[Path, ...]) -> bytes | None:
        value = cls.decode(raw)
        changed = False
        for path in paths:
            changed = cls.remove_entry(value, path) or changed
        return cls.encode(value) if changed else raw


__all__ = ["ProjectRegistry"]
