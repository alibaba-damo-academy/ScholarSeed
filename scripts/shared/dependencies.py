"""Freeze and verify Desktop's lock-derived Python runtime inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tomllib
import zipfile
from email.parser import BytesParser
from pathlib import Path
from typing import Any

BUILD_GROUP_PREFIX = "component-build-"
SOURCE_TARGETS_KEY = "source-build-targets"
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
import os
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
# win32 组件化布局 (proposal 108 §7): 产品发行物不在 site-packages, 而在随应用版本
# 交付的 pylibs 根 (构建步骤经 SCHOLARSEED_PRODUCT_LIBS 声明)。清单必须看到它们,
# 否则 verify 的 installed 投影缺 5 个本地发行物, 构建在该步必失败。
product_libs = os.environ.get("SCHOLARSEED_PRODUCT_LIBS", "")
if product_libs:
    sites.add(product_libs)
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


def lock_digest(path: Path) -> str:
    # Git may check out the same lock with CRLF on Windows. Its text identity,
    # unlike an archive byte digest, must not split a reusable component.
    raw = path.read_bytes()
    if b"\r" in raw.replace(b"\r\n", b""):
        raise ValueError("uv.lock contains unsupported carriage returns")
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


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


def build_constraints(repo: Path, uv: Path, group: str) -> str:
    """Use uv's resolver to export the complete locked build environment."""
    builders = subprocess.run(
        [
            str(uv),
            "export",
            "--locked",
            "--only-group",
            group,
            "--no-emit-workspace",
            "--no-header",
            "--no-annotate",
        ],
        cwd=repo,
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    ).stdout.strip()
    if not builders or "--hash=sha256:" not in builders:
        raise ValueError(f"source build group has no hashed builder closure: {group}")
    return builders + "\n"


def source_builds(repo: Path, uv: Path, requirements: Path) -> list[dict[str, Any]]:
    """Export each isolated builder from the same lock as its runtime source."""
    project = tomllib.loads((repo / PROJECT_FILENAME).read_text(encoding="utf-8"))
    lock = tomllib.loads((repo / LOCK_FILENAME).read_text(encoding="utf-8"))
    runtime = requirements.read_text(encoding="utf-8")
    targets = project.get("tool", {}).get("scholarseed", {}).get(SOURCE_TARGETS_KEY, {})
    target = f"{sys.platform}-{platform.machine().lower()}"
    groups = project.get("dependency-groups", {})
    for name, selected in targets.items():
        if (
            f"{BUILD_GROUP_PREFIX}{name}" not in groups
            or not isinstance(selected, list)
            or not selected
        ):
            raise ValueError(f"invalid source build targets: {name}")
        if any(
            not isinstance(value, str) or not re.fullmatch(r"[a-z0-9]+-[a-z0-9_]+", value)
            for value in selected
        ):
            raise ValueError(f"invalid source build targets: {name}")
    result = []
    for group in sorted(groups):
        if not group.startswith(BUILD_GROUP_PREFIX):
            continue
        name = group.removeprefix(BUILD_GROUP_PREFIX)
        if canonical(name) != name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            raise ValueError(f"invalid source build group: {group}")
        versions = set(re.findall(rf"^{re.escape(name)}==([^ ;\\\n\r]+)", runtime, re.MULTILINE))
        packages = [
            package
            for package in lock["package"]
            if package["name"] == name and package["version"] in versions
        ]
        if len(versions) != 1 or len(packages) != 1:
            raise ValueError(f"source build group must select one locked runtime source: {group}")
        package = packages[0]
        source_hash = package.get("sdist", {}).get("hash", "")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", source_hash):
            raise ValueError(f"source build group has no locked sdist: {group}")
        if name in targets and target not in targets[name]:
            continue
        builders = build_constraints(repo, uv, group)
        result.append(
            {
                "name": name,
                "version": package["version"],
                "sha256": source_hash.removeprefix("sha256:"),
                "buildConstraints": builders,
            }
        )
    return result


def export(repo: Path, uv: Path, requirements: Path, plan: Path) -> None:
    repo = repo.resolve()
    wheels = skill_inputs(repo)
    lock_path = repo / LOCK_FILENAME
    lock_sha256 = lock_digest(lock_path)
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
    builders = source_builds(repo, uv, requirements)
    wheel_builders = build_constraints(repo, uv, "wheel-build")
    if lock_digest(lock_path) != lock_sha256:
        raise ValueError("dependency export changed uv.lock")
    write_json(
        plan,
        {
            "schema": SCHEMA_VERSION,
            "lock_sha256": lock_sha256,
            "requirements_sha256": digest(requirements),
            "source_builds": builders,
            "wheel_build_constraints": wheel_builders,
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
    if os.environ.get("SCHOLARSEED_PRODUCT_LIBS"):
        # pip check 必须能看到 pylibs 里的产品发行物才能校验它们的依赖边;
        # -I 会忽略 PYTHONPATH, 换成 -s (关用户 site) + 显式 PYTHONPATH。
        env = {**os.environ, "PYTHONPATH": os.environ["SCHOLARSEED_PRODUCT_LIBS"]}
        subprocess.run([sys.executable, "-s", "-B", "-m", "pip", "check"], check=True, env=env)
    else:
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
