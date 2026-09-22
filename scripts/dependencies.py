"""Freeze and verify Desktop's lock-derived Python runtime inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tomllib
import zipfile
from email.parser import BytesParser
from pathlib import Path
from typing import Any

DESKTOP_GROUP = "desktop"
SERVE_EXTRA = "serve"
LOCK_FILENAME = "uv.lock"
PROJECT_FILENAME = "pyproject.toml"
REGISTRY_RELATIVE = "skills/registry.json"
SKILLS_RELATIVE = "skills/community"
NAME_PATTERN = re.compile(r"[-_.]+")
REQUIREMENT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*")
SCHEMA_VERSION = 1
# This separate interpreter entrypoint runs only after the locked sync. Bootstrap
# export itself needs only the standard library shipped in standalone Python.
INVENTORY_PROJECTION = r"""
import importlib.metadata
import json
import sys
import sysconfig

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

required = {}
for line in sys.stdin.read().replace("\\\n", "").splitlines():
    specification = line.split(" --hash=", 1)[0].strip()
    if not specification or specification.startswith("#"):
        continue
    requirement = Requirement(specification)
    pins = list(requirement.specifier)
    if requirement.url or requirement.extras or len(pins) != 1 or pins[0].operator != "==" or "*" in pins[0].version:
        raise ValueError("release requirements must contain exact registry pins")
    if requirement.marker and not requirement.marker.evaluate():
        continue
    name, version = canonicalize_name(requirement.name), pins[0].version
    if name in required and required[name] != version:
        raise ValueError(f"conflicting active release pins: {name}")
    required[name] = version
installed = {}
# Inventory installed distributions, not source-tree egg-info exposed by editable
# .pth files. The bundler separately rejects editable/local namespace fallbacks.
sites = {sysconfig.get_path("purelib"), sysconfig.get_path("platlib")}
for distribution in importlib.metadata.distributions(path=sites):
    name = canonicalize_name(distribution.metadata["Name"])
    if name in installed:
        raise ValueError(f"duplicate installed distribution: {name}")
    installed[name] = distribution.version
print(json.dumps({"required": required, "installed": installed}))
"""


def canonical(name: str) -> str:
    return NAME_PATTERN.sub("-", name).lower()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def wheel_identity(path: Path) -> dict[str, str]:
    with zipfile.ZipFile(path) as archive:
        candidates = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(candidates) != 1:
            raise ValueError(f"wheel must contain exactly one METADATA: {path.name}")
        metadata = BytesParser().parsebytes(archive.read(candidates[0]))
    if not metadata["Name"] or not metadata["Version"]:
        raise ValueError(f"wheel identity is missing: {path.name}")
    return {
        "name": canonical(metadata["Name"]),
        "version": metadata["Version"],
        "sha256": digest(path),
    }


def skill_inputs(repo: Path) -> list[Path]:
    """Reject registry requirements omitted from the workspace's release profile."""
    project = tomllib.loads((repo / PROJECT_FILENAME).read_text(encoding="utf-8"))
    group = project["dependency-groups"][DESKTOP_GROUP]
    if not all(isinstance(requirement, str) for requirement in group):
        raise ValueError("desktop dependencies must be explicit requirements")
    names = {
        canonical(match.group())
        for requirement in group
        if (match := REQUIREMENT_NAME.match(requirement))
    }
    registry = json.loads((repo / REGISTRY_RELATIVE).read_bytes())
    sources = project["tool"]["uv"]["sources"]
    wheels: list[Path] = []
    for slug, dependencies in registry["dependencies"].items():
        missing = set(dependencies.get("python", [])) - set(group)
        if missing:
            raise ValueError(f"desktop group omits reviewed skill pins: {slug}: {sorted(missing)}")
        skill = (repo / SKILLS_RELATIVE / slug).resolve()
        for relative in dependencies.get("wheels", []):
            wheel = (skill / relative).resolve()
            if not wheel.is_relative_to(skill):
                raise ValueError(f"skill wheel is outside its source: {slug}")
            identity = wheel_identity(wheel)
            name = identity["name"]
            source = sources.get(name, {})
            if name not in names or not source.get("path"):
                raise ValueError(f"desktop group omits reviewed skill wheel source: {name}")
            if (repo / source["path"]).resolve() != wheel:
                raise ValueError(f"desktop skill wheel source differs: {name}")
            wheels.append(wheel)
    return sorted(set(wheels))


def export(repo: Path, uv: Path, requirements: Path, plan: Path) -> None:
    repo = repo.resolve()
    wheels = skill_inputs(repo)
    lock_path = repo / LOCK_FILENAME
    lock_digest = digest(lock_path)
    requirements.parent.mkdir(parents=True, exist_ok=True)
    excluded = [wheel_identity(wheel)["name"] for wheel in wheels]
    subprocess.run(
        [
            str(uv),
            "export",
            "--locked",
            "--all-packages",
            "--extra",
            SERVE_EXTRA,
            "--group",
            DESKTOP_GROUP,
            "--no-default-groups",
            "--no-emit-workspace",
            "--no-header",
            "--no-annotate",
            "--format",
            "requirements.txt",
            "--output-file",
            str(requirements.resolve()),
            *(argument for name in excluded for argument in ("--no-emit-package", name)),
        ],
        cwd=repo,
        stdout=subprocess.DEVNULL,
        check=True,
    )
    if digest(lock_path) != lock_digest:
        raise ValueError("dependency export changed uv.lock")
    write_json(
        plan,
        {
            "schema": SCHEMA_VERSION,
            "lock_sha256": lock_digest,
            "requirements_sha256": digest(requirements),
            "skill_wheels": [{"path": str(wheel), **wheel_identity(wheel)} for wheel in wheels],
        },
    )


def project_inventory(requirements: Path) -> dict[str, dict[str, str]]:
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", INVENTORY_PROJECTION],
        input=requirements.read_text(encoding="utf-8"),
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    )
    return json.loads(result.stdout)


def compare(expected: dict[str, str], actual: dict[str, str]) -> None:
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    changed = sorted(name for name in set(actual) & set(expected) if actual[name] != expected[name])
    if missing or extra or changed:
        raise ValueError(
            f"Python inventory drift: missing={missing}, extra={extra}, changed={changed}"
        )


def snapshot(plan: Path, requirements: Path, wheels: list[Path], output: Path) -> None:
    """Prove sync matches target lock pins before adding reviewed local wheels."""
    prepared = json.loads(plan.read_bytes())
    if digest(requirements) != prepared["requirements_sha256"]:
        raise ValueError("frozen Python requirements changed")
    projection = project_inventory(requirements)
    packages = projection["required"]
    compare(packages, projection["installed"])
    local = [wheel_identity(wheel) for wheel in wheels]
    for wheel in (*local, *prepared["skill_wheels"]):
        name, version = wheel["name"], wheel["version"]
        if name in packages:
            raise ValueError(f"local wheel unexpectedly present after third-party sync: {name}")
        packages[name] = version
    write_json(
        output,
        {
            "schema": SCHEMA_VERSION,
            "lock_sha256": prepared["lock_sha256"],
            "requirements_sha256": prepared["requirements_sha256"],
            "packages": packages,
            "workspace_wheels": local,
            "skill_wheels": [
                {key: value for key, value in wheel.items() if key != "path"}
                for wheel in prepared["skill_wheels"]
            ],
        },
    )


def verify(manifest: Path, requirements: Path) -> None:
    expected = json.loads(manifest.read_bytes())
    if expected.get("schema") != SCHEMA_VERSION:
        raise ValueError("unsupported Python dependency evidence schema")
    if digest(requirements) != expected["requirements_sha256"]:
        raise ValueError("frozen Python requirements changed")
    projection = project_inventory(requirements)
    packages = projection["required"]
    for wheel in (*expected["workspace_wheels"], *expected["skill_wheels"]):
        if wheel["name"] in packages:
            raise ValueError(f"duplicate local distribution: {wheel['name']}")
        packages[wheel["name"]] = wheel["version"]
    compare(packages, expected["packages"])
    compare(packages, projection["installed"])
    subprocess.run([sys.executable, "-I", "-B", "-m", "pip", "check"], check=True)
    print(f"[dependencies] verified {len(packages)} locked distributions")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    operations = parser.add_subparsers(dest="operation", required=True)
    exporting = operations.add_parser("export")
    exporting.add_argument("--repo", type=Path, required=True)
    exporting.add_argument("--uv", type=Path, required=True)
    exporting.add_argument("--requirements", type=Path, required=True)
    exporting.add_argument("--plan", type=Path, required=True)
    capturing = operations.add_parser("snapshot")
    capturing.add_argument("--plan", type=Path, required=True)
    capturing.add_argument("--requirements", type=Path, required=True)
    capturing.add_argument("--wheel", type=Path, action="append", required=True)
    capturing.add_argument("--output", type=Path, required=True)
    checking = operations.add_parser("verify")
    checking.add_argument("--manifest", type=Path, required=True)
    checking.add_argument("--requirements", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.operation == "export":
        export(arguments.repo, arguments.uv, arguments.requirements, arguments.plan)
    elif arguments.operation == "snapshot":
        snapshot(arguments.plan, arguments.requirements, arguments.wheel, arguments.output)
    else:
        verify(arguments.manifest, arguments.requirements)


if __name__ == "__main__":
    main()
