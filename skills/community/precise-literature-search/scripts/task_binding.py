#!/usr/bin/env scholarseed-skill-python
"""Run-local task identity evidence: serve verifies it, the skill only records it.

The skill cannot claim a product task lease; it leaves the binding file that serve
re-checks against its own skill inventory and hands the model the request to relay.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from io_utils import atomic_write_json, read_json

SKILL_ROOT = Path(__file__).resolve().parent.parent
SKILL_NAME = "precise-literature-search"
TASK_TYPE = "precise_search"
RUN_ROOT_NAME = ".precise-literature-search"
RUNS_DIR_NAME = "runs"
BINDING_FILE = ".pls-binding.json"
BINDING_SCHEMA_VERSION = "1.0"
CAPABILITY = "task"
OPERATION = "activate"
ACTIVATION_HINT = (
    "call the scholarseed_bridge model tool with this exact request once per turn, "
    "before any literature or pdf operation; the lease belongs to the turn that "
    "activated it and expires with it"
)
MANIFEST_VERSION = re.compile(r'^version:\s*"?([^"\r\n]+?)"?\s*$', re.MULTILINE)


def skill_version() -> str:
    """The manifest version serve compares against its own runtime inventory."""

    manifest = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
    parts = manifest.split("---", 2)
    match = MANIFEST_VERSION.search(parts[1]) if len(parts) > 2 else None
    if match is None:
        raise ValueError("the skill manifest carries no version to bind")
    return match.group(1)


def write_binding(run_dir: Path, work_dir: Path) -> dict:
    binding = {
        "schema_version": BINDING_SCHEMA_VERSION,
        "skill": str(SKILL_ROOT),
        "version": skill_version(),
        "workspace": str(run_dir.resolve()),
        "run_id": run_dir.name,
        "work_dir": str(work_dir.resolve()),
        "python": sys.executable,
        "platform": sys.platform,
    }
    atomic_write_json(run_dir / BINDING_FILE, binding)
    return binding


def ensure_binding(run_dir: Path) -> dict:
    """Return the run's binding, regenerating it for a run resumed from an older skill."""

    path = run_dir / BINDING_FILE
    if path.is_file():
        binding = read_json(path)
        if isinstance(binding, dict) and binding.get("run_id") == run_dir.name:
            current_run = run_dir.resolve()
            if (
                binding.get("version") != skill_version()
                and binding.get("skill") == str(SKILL_ROOT)
                and binding.get("workspace") == str(current_run)
                and binding.get("work_dir") == str(current_run.parents[2])
            ):
                return write_binding(run_dir, current_run.parents[2])
            return binding
    if run_dir.parent.name != RUNS_DIR_NAME or run_dir.parent.parent.name != RUN_ROOT_NAME:
        raise ValueError("not a run directory of this skill")
    return write_binding(run_dir, run_dir.resolve().parents[2])


def activation_request(run_dir: Path) -> dict:
    """The bridge request that activates this run's lease in the current turn."""

    binding = ensure_binding(run_dir)
    relative = run_dir.resolve().relative_to(Path(binding["work_dir"]))
    return {
        "capability": CAPABILITY,
        "operation": OPERATION,
        "request": {
            "task_type": TASK_TYPE,
            "skill_name": SKILL_NAME,
            "skill_version": binding["version"],
            "skill_path": binding["skill"],
            "workspace": relative.as_posix(),
            "run_id": binding["run_id"],
        },
    }
