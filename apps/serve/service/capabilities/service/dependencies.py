"""Provision and prove the reviewed skill dependencies in the product interpreter."""

from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from packaging.requirements import Requirement
from packaging.utils import parse_wheel_filename

from service.capabilities.service.manifest import load_lock, verify_runtime_target
from service.capabilities.service.package import (
    MAX_FILE_BYTES,
    PackageError,
    declaration,
    digest,
    validate_paths,
)
from service.capabilities.service.prebundle import verify_locked_pack
from service.capabilities.service.source import (
    LOCK_SOURCE,
    load_source_lock,
    verify_source_locked_pack,
)
from service.platform.storage import filesystem_path

PROBE_TIMEOUT_SECONDS = 60
INSTALL_TIMEOUT_SECONDS = 1800
PYTHON_FLAGS = ("-I", "-B")
# Native toolchain executables carry a platform suffix. POSIX permission bits do
# not round-trip on Windows, so existence is the executability evidence there.
EXECUTABLE_SUFFIX = ".exe" if os.name == "nt" else ""


def _inputs(lock_path: Path, root: Path) -> dict[str, Any]:
    lock_path, root = filesystem_path(lock_path), filesystem_path(root)
    candidate = json.loads(lock_path.read_bytes())
    if isinstance(candidate, dict) and candidate.get("source") == LOCK_SOURCE:
        lock = load_source_lock(lock_path)
        verified = verify_source_locked_pack(lock_path, root)
        lock["target"] = {
            "platform": sys.platform,
            "machine": platform.machine(),
            "python": platform.python_version(),
        }
    else:
        lock = load_lock(lock_path)
        verify_runtime_target(lock)
        verified = verify_locked_pack(lock_path, root)
    if not verified.ok:
        raise PackageError(
            f"cannot provision or verify a drifting skill pack: {dict(verified.errors)}"
        )
    names = {row["slug"] for row in lock["skills"]}
    for row in lock["skills"]:
        dependencies = declaration(row["dependencies"])
        if set(dependencies.get("skills", [])) - names:
            raise PackageError(f"missing skill dependency: {row['slug']}")
        payload = {item["path"] for item in row["files"]}
        if set(dependencies.get("wheels", [])) - payload:
            raise PackageError(f"wheel is not part of the locked payload: {row['slug']}")
    return lock


def _python(arguments: list[str], *, installing: bool = False) -> None:
    # No checkout, PYTHONPATH or user site may mask a missing installed dependency.
    with tempfile.TemporaryDirectory(prefix="scholarseed-dependency-probe-") as directory:
        result = subprocess.run(
            [sys.executable, *PYTHON_FLAGS, *arguments],
            cwd=directory,
            capture_output=not installing,
            text=True,
            check=False,
            timeout=INSTALL_TIMEOUT_SECONDS if installing else PROBE_TIMEOUT_SECONDS,
        )
    if result.returncode:
        # Dependency output may contain host paths or config. Keep diagnostic
        # identities, not arbitrary third-party output, in build reports.
        raise PackageError(f"product Python dependency command failed: {arguments[:3]}")


def provision_dependencies(
    lock_path: Path, root: Path, toolchain_root: Path | None = None
) -> dict[str, Any]:
    root = filesystem_path(root)
    lock = _inputs(lock_path, root)
    requirements = sorted(
        {spec for row in lock["skills"] for spec in row["dependencies"].get("python", [])}
    )
    for specification in requirements:
        _verify_python_requirement(specification)
    wheels = [
        str((root / row["slug"] / wheel).resolve())
        for row in lock["skills"]
        for wheel in row["dependencies"].get("wheels", [])
    ]
    if wheels:
        _python(
            [
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-compile",
                "--no-deps",
                "--no-index",
                "--force-reinstall",
                *wheels,
            ],
            installing=True,
        )
    return verify_dependencies(lock_path, root, toolchain_root)


def _verify_python_requirement(specification: str) -> None:
    requirement = Requirement(specification)
    try:
        installed_version = importlib.metadata.version(requirement.name)
    except importlib.metadata.PackageNotFoundError as exc:
        raise PackageError(
            f"missing locked product dependency: {requirement.name}; install the desktop group first"
        ) from exc
    if installed_version not in requirement.specifier:
        raise PackageError(f"installed dependency differs from pin: {specification}")


def verify_wheel(wheel: Path) -> dict[str, Any]:
    """Tie the installed library bytes to the exact locked wheel, not just its version."""
    name, version, _build, _tags = parse_wheel_filename(wheel.name)
    try:
        installed = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError as exc:
        raise PackageError(f"missing installed wheel distribution: {name}") from exc
    if installed.version != str(version):
        raise PackageError(f"installed wheel version differs: {name}")
    direct = json.loads(installed.read_text("direct_url.json") or "{}")
    checksum = digest(wheel.read_bytes())
    if direct.get("archive_info", {}).get("hashes", {}).get("sha256") != checksum:
        raise PackageError(f"installed wheel provenance differs from locked payload: {name}")
    verified = 0
    with zipfile.ZipFile(wheel) as archive:
        files = [item for item in archive.infolist() if not item.is_dir()]
        validate_paths([item.filename for item in files])
        for item in files:
            relative = item.filename
            if stat.S_ISLNK(item.external_attr >> 16) or item.file_size > MAX_FILE_BYTES:
                raise PackageError("unsupported or oversized vendored wheel entry")
            parts = relative.split("/")
            if parts[0].endswith(".data"):
                if len(parts) < 3 or parts[1] not in {"purelib", "platlib"}:
                    raise PackageError(
                        "vendored wheel relocation must target a Python library directory"
                    )
                relative = "/".join(parts[2:])
            # pip regenerates RECORD and records its own installation provenance.
            if parts[0].endswith(".dist-info") and parts[-1] == "RECORD":
                continue
            destination = Path(str(installed.locate_file(relative)))
            if destination.is_symlink() or not destination.is_file():
                raise PackageError(f"installed wheel file is missing or linked: {name}/{relative}")
            if digest(destination.read_bytes()) != digest(archive.read(item)):
                raise PackageError(f"installed wheel bytes differ: {name}/{relative}")
            verified += 1
    return {
        "name": name,
        "version": str(version),
        "wheel_sha256": checksum,
        "verified_files": verified,
    }


def _bundled_executables(
    names: list[str], toolchain_root: Path | None, slug: str
) -> dict[str, str]:
    """Resolve native tools the product ships, not whatever the host PATH offers.

    `executables` are product entry points that already sit next to the product
    interpreter, and `optional_executables` are host capabilities that are only
    reported. Bundled toolchains are a third case: the product supplies them, so
    the check is that the staged toolchain actually contains them.
    """
    if not names:
        return {}
    if toolchain_root is None:
        raise PackageError(f"bundled native skill dependencies require a toolchain root: {slug}")
    resolved = {}
    for name in names:
        candidate = toolchain_root / f"{name}{EXECUTABLE_SUFFIX}"
        if not candidate.is_file() or (os.name != "nt" and not os.access(candidate, os.X_OK)):
            raise PackageError(f"bundled native skill dependency missing: {slug}: {name}")
        resolved[name] = str(candidate)
    return resolved


def verify_dependencies(
    lock_path: Path, root: Path, toolchain_root: Path | None = None
) -> dict[str, Any]:
    root = filesystem_path(root)
    lock = _inputs(lock_path, root)
    _python(["-m", "pip", "check"])
    results = []
    for row in lock["skills"]:
        dependencies = row["dependencies"]
        wheels = [
            verify_wheel(root / row["slug"] / filename)
            for filename in dependencies.get("wheels", [])
        ]
        for specification in dependencies.get("python", []):
            _verify_python_requirement(specification)
        for module in dependencies.get("imports", []):
            _python(["-c", f"import {module}"])
        for module in dependencies.get("modules", []):
            _python(["-m", module, "--help"])
        required = {
            name: shutil.which(name) is not None for name in dependencies.get("executables", [])
        }
        if not all(required.values()):
            raise PackageError(f"required native skill dependencies missing: {row['slug']}")
        bundled = _bundled_executables(
            dependencies.get("bundled_executables", []), toolchain_root, row["slug"]
        )
        optional = {
            name: shutil.which(name) is not None
            for name in dependencies.get("optional_executables", [])
        }
        results.append(
            {
                "skill": row["slug"],
                "required_executables": required,
                "bundled_executables": bundled,
                "optional_executables": optional,
                "imports": dependencies.get("imports", []),
                "modules": dependencies.get("modules", []),
                "wheels": wheels,
            }
        )
    installed = sorted(
        {
            (distribution.metadata["Name"], distribution.version)
            for distribution in importlib.metadata.distributions()
        }
    )
    return {
        "target": lock["target"],
        "skills": results,
        "installed_distributions": [
            {"name": name, "version": version} for name, version in installed
        ],
    }
