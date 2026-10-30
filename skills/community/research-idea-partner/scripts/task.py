#!/usr/bin/env scholarseed-skill-python
"""Prepare a research-idea binding and its current-turn activation request."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

SKILL_NAME = "research-idea-partner"
TASK_TYPE = "research_idea"
BINDING_FILE = ".rip-binding.json"
VERSION_FILE = "VERSION"
TEXT_ENCODING = "utf-8"


def prepare_task(workspace: Path) -> dict[str, Any]:
    root = Path.cwd().resolve()
    workspace = workspace.resolve(strict=True)
    relative = workspace.relative_to(root)
    if not workspace.is_dir():
        raise ValueError("task_workspace_invalid")
    skill = Path(__file__).resolve().parents[1]
    version = (skill / VERSION_FILE).read_text(encoding=TEXT_ENCODING).strip()
    if not version:
        raise ValueError("task_skill_version_missing")
    binding = {"skill": str(skill), "version": version, "workspace": str(workspace)}
    (workspace / BINDING_FILE).write_text(
        json.dumps(binding, ensure_ascii=False, sort_keys=True) + "\n", encoding=TEXT_ENCODING
    )
    return {
        "task_activation": {
            "capability": "task",
            "operation": "activate",
            "request": {
                "task_type": TASK_TYPE,
                "skill_name": SKILL_NAME,
                "skill_version": version,
                "skill_path": str(skill),
                "workspace": relative.as_posix(),
            },
        }
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", type=Path)
    arguments = parser.parse_args(argv)
    try:
        result = prepare_task(arguments.workspace)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
