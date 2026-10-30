"""Frozen skill build inputs and content checks, with no registry/network access."""

from __future__ import annotations

import json
import os
import platform
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

from service.capabilities.service.audit import audit_passed
from service.capabilities.service.package import (
    EXECUTABLE_MODE,
    FILE_MODE,
    MAX_FILE_BYTES,
    MAX_FILES,
    PACKAGE_MANIFEST,
    VERSION_PATTERN,
    PackageError,
    SkillPackage,
    digest,
    json_bytes,
    read_package,
    validate_paths,
)
from service.platform.storage import filesystem_path

LOCK_SCHEMA = 2
LOCK_FILENAME = "skills.lock.json"
HASH_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
COMMIT_PATTERN = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
PYTHON_VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
TARGET_FIELDS = frozenset({"platform", "machine", "python"})
TARGET_PLATFORMS = frozenset({"darwin", "linux", "win32"})
TARGET_MACHINES = frozenset({"arm64", "aarch64", "x86_64", "AMD64"})
IDENTITY_FIELDS = ("skillId", "namespace", "slug", "version", "versionId", "fingerprint")


def validate_target(target: dict[str, str]) -> dict[str, str]:
    try:
        valid = (
            set(target) == TARGET_FIELDS
            and target["platform"] in TARGET_PLATFORMS
            and target["machine"] in TARGET_MACHINES
            and PYTHON_VERSION_PATTERN.fullmatch(target["python"])
        )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise PackageError("build target must declare platform, machine and exact Python version")
    return target


def verify_runtime_target(lock: dict[str, Any]) -> None:
    actual = {
        "platform": sys.platform,
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
    if validate_target(lock["target"]) != actual:
        raise PackageError(f"build target differs from executing product Python: {actual}")


def atomic_write(path: Path, data: bytes) -> None:
    path = filesystem_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_lock(lock: dict[str, Any]) -> dict[str, Any]:
    try:
        if lock["schema"] != LOCK_SCHEMA or not lock["registry"] or not lock["namespace"]:
            raise PackageError("invalid skill lock header")
        if not COMMIT_PATTERN.fullmatch(lock["git_commit"]):
            raise PackageError("skill lock requires the exact source Git commit")
        validate_target(lock["target"])
        if not HASH_PATTERN.fullmatch(lock["dependency_policy_sha256"]):
            raise PackageError("invalid dependency policy digest")
        if not isinstance(lock["scanners"], list) or not lock["scanners"]:
            raise PackageError("skill lock must require security scanners")
        rows = lock["skills"]
        if not isinstance(rows, list) or not rows:
            raise PackageError("skill lock cannot contain an empty or partial collection")
        validate_paths([row["slug"] for row in rows])
        ids = [row["skillId"] for row in rows]
        if len(set(ids)) != len(ids):
            raise PackageError("duplicate skill ID in lock")
        for row in rows:
            if row["namespace"] != lock["namespace"] or not all(
                row.get(field) for field in IDENTITY_FIELDS
            ):
                raise PackageError("invalid locked skill identity")
            if "/" in row["slug"] or not VERSION_PATTERN.fullmatch(row["version"]):
                raise PackageError("invalid locked skill name/version")
            if not isinstance(row["dependencies"], dict):
                raise PackageError("missing locked dependency declaration")
            for key in ("zip_sha256", "manifest_sha256"):
                if not HASH_PATTERN.fullmatch(row[key]):
                    raise PackageError(f"invalid lock digest: {key}")
            for scanner in lock["scanners"]:
                audits = row["audits"][scanner]
                if not audits or not all(
                    audit_passed(audit, scanner, row["files"]) for audit in audits
                ):
                    raise PackageError(f"unapproved scan in lock: {row['slug']}/{scanner}")
            if not isinstance(row["files"], list) or not row["files"]:
                raise PackageError("missing locked file inventory")
            validate_paths([item["path"] for item in row["files"]])
            if len(row["files"]) > MAX_FILES or PACKAGE_MANIFEST not in {
                item["path"] for item in row["files"]
            }:
                raise PackageError("invalid locked file inventory")
            for item in row["files"]:
                if (
                    not isinstance(item["size"], int)
                    or isinstance(item["size"], bool)
                    or not 0 <= item["size"] <= MAX_FILE_BYTES
                    or item["mode"] not in {FILE_MODE, EXECUTABLE_MODE}
                    or not HASH_PATTERN.fullmatch(item["sha256"])
                ):
                    raise PackageError("invalid locked file hash, size or mode")
    except (KeyError, TypeError, AttributeError) as exc:
        raise PackageError("invalid skill lock schema") from exc
    return lock


def load_lock(path: Path) -> dict[str, Any]:
    return validate_lock(json.loads(path.read_bytes()))


def package_for(row: dict[str, Any], data: bytes) -> SkillPackage:
    if digest(data) != row["zip_sha256"] or len(data) != row["zip_size"]:
        raise PackageError(f"locked ZIP integrity mismatch: {row['slug']}")
    package = read_package(data)
    if (
        package.name != row["slug"]
        or package.version != row["version"]
        or package.fingerprint != row["fingerprint"]
    ):
        raise PackageError(f"locked package identity mismatch: {row['slug']}")
    if digest(package.files[PACKAGE_MANIFEST].data) != row["manifest_sha256"]:
        raise PackageError(f"locked manifest mismatch: {row['slug']}")
    if package.manifest["dependencies"] != row["dependencies"]:
        raise PackageError(f"locked dependencies differ from package manifest: {row['slug']}")
    if sorted(row["files"], key=lambda item: item["path"]) != [
        item.record(path) for path, item in sorted(package.files.items())
    ]:
        raise PackageError(f"locked file inventory mismatch: {row['slug']}")
    return package


def cache_path(cache: Path, row: dict[str, Any]) -> Path:
    checksum = row["zip_sha256"]
    if not HASH_PATTERN.fullmatch(checksum):
        raise PackageError("invalid cache digest")
    return cache / f"{checksum}.zip"


def policy_digest(config: dict[str, Any]) -> str:
    return digest(json_bytes(config["dependencies"]))
