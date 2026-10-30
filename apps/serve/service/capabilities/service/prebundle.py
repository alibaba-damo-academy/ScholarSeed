"""Compile the frozen Skillhub inputs offline into the immutable product pack."""

from __future__ import annotations

import json
import os
import stat
import tempfile
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping

import yaml

from service.capabilities.domain import SKILL_MANIFEST_NAME
from service.capabilities.service.install import (
    MAX_PACKAGE_BYTES,
    SKILL_NAME_PATTERN,
    parse_skill_frontmatter,
)
from service.capabilities.service.manifest import (
    cache_path,
    load_lock,
    package_for,
    verify_runtime_target,
)
from service.capabilities.service.package import (
    EXECUTABLE_MODE,
    FILE_MODE,
    PACKAGE_MANIFEST,
    digest,
    extract_package,
    json_bytes,
)
from service.capabilities.service.skills import SKILL_PRODUCT_METADATA_FILE
from service.platform.storage import WINDOWS_PLATFORM, filesystem_path

SKILL_INTERFACE_FILE = Path("agents") / "openai.yaml"
SKILL_PACK_ORIGIN = "skillhub"
SKILL_PACK_CATEGORY = "系统预置"
SKILL_PACK_ICON = "skills"
REQUIRED_METADATA_FIELDS = frozenset({"version", "origin", "category", "blurb"})
FORBIDDEN_HARNESS_MARKERS = (
    "TodoWrite",
    "WebFetch",
    "work=scholar",
)
PACK_VALIDATION_KEY = "<pack>"


class SkillPackError(ValueError):
    """Frozen inputs cannot be compiled into a safe, unambiguous skill pack."""


@dataclass(frozen=True)
class SkillPackValidation:
    discovered: tuple[str, ...] = ()
    errors: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors

    def summary(self) -> str:
        return f"discovered={len(self.discovered)} failed={len(self.errors)}"


@dataclass(frozen=True)
class SkillPackBuild:
    packages: tuple[str, ...]
    skills: tuple[str, ...]

    def summary(self) -> str:
        return f"packages={len(self.packages)} skills={len(self.skills)}"


def _mapping_file(path: Path) -> Mapping[str, Any]:
    if not path.is_file():
        return {}
    try:
        if path.suffix in {".yaml", ".yml"}:
            value = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        else:
            value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError, yaml.YAMLError):
        return {}
    return value if isinstance(value, Mapping) else {}


def _validate_skill(directory: Path) -> tuple[str, ...]:
    errors: list[str] = []
    manifest = directory / SKILL_MANIFEST_NAME
    if not manifest.is_file():
        return (f"missing {SKILL_MANIFEST_NAME}",)
    try:
        text = manifest.read_text(encoding="utf-8")
        frontmatter, _body = parse_skill_frontmatter(text)
    except (OSError, ValueError) as exc:
        return (f"invalid {SKILL_MANIFEST_NAME}: {exc}",)
    if str(frontmatter.get("name") or "") != directory.name:
        errors.append("frontmatter name must match the skill directory")
    if not SKILL_NAME_PATTERN.fullmatch(directory.name):
        errors.append("skill name is not a safe portable directory name")
    if not str(frontmatter.get("description") or "").strip():
        errors.append("frontmatter description is required")
    for marker in FORBIDDEN_HARNESS_MARKERS:
        if marker in text:
            errors.append(f"contains retired DamoAgent marker {marker!r}")
    metadata = _mapping_file(directory / SKILL_PRODUCT_METADATA_FILE)
    missing_metadata = sorted(
        field_name for field_name in REQUIRED_METADATA_FIELDS if not metadata.get(field_name)
    )
    if missing_metadata:
        errors.append(f"missing product metadata: {', '.join(missing_metadata)}")

    interface = _mapping_file(directory / SKILL_INTERFACE_FILE)
    dependencies = interface.get("dependencies") if isinstance(interface, Mapping) else None
    tools = dependencies.get("tools") if isinstance(dependencies, Mapping) else None
    if tools is not None and not isinstance(tools, list):
        errors.append("agents/openai.yaml dependencies.tools must be a list")
    elif isinstance(tools, list):
        for index, row in enumerate(tools):
            if (
                not isinstance(row, Mapping)
                or not str(row.get("type") or "").strip()
                or not str(row.get("value") or "").strip()
            ):
                errors.append(f"dependency {index} requires type and value")
    return tuple(errors)


def validate_bundled_skills(
    root: Path,
    *,
    expected: frozenset[str] | None = None,
) -> SkillPackValidation:
    """Validate one compiled pack and optionally require its exact skill set."""

    root = filesystem_path(root.expanduser())
    discovered = (
        tuple(
            sorted(
                directory.name
                for directory in root.iterdir()
                if directory.is_dir() and (directory / SKILL_MANIFEST_NAME).is_file()
            )
        )
        if root.is_dir()
        else ()
    )
    errors: dict[str, tuple[str, ...]] = {}
    if not discovered:
        errors[PACK_VALIDATION_KEY] = ("empty or missing skill pack",)
    if expected is not None:
        actual = frozenset(discovered)
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        pack_errors: list[str] = []
        if missing:
            pack_errors.append(f"missing required skills: {', '.join(missing)}")
        if unexpected:
            pack_errors.append(f"unexpected skills: {', '.join(unexpected)}")
        if pack_errors:
            errors[PACK_VALIDATION_KEY] = (*errors.get(PACK_VALIDATION_KEY, ()), *pack_errors)
    if root.is_dir():
        unexpected_entries = [
            child.name
            for child in root.iterdir()
            if child.is_symlink() or child.name not in discovered
        ]
        if unexpected_entries:
            errors[PACK_VALIDATION_KEY] = (
                *errors.get(PACK_VALIDATION_KEY, ()),
                f"unexpected pack entries: {', '.join(sorted(unexpected_entries))}",
            )
    for name in discovered:
        rows = _validate_skill(root / name)
        if rows:
            errors[name] = rows
    return SkillPackValidation(discovered=discovered, errors=errors)


def _skill_blurb(directory: Path, frontmatter: Mapping[str, Any]) -> str:
    interface = _mapping_file(directory / SKILL_INTERFACE_FILE)
    interface_row = interface.get("interface") if isinstance(interface, Mapping) else None
    if isinstance(interface_row, Mapping):
        short_description = str(interface_row.get("short_description") or "").strip()
        if short_description:
            return short_description
    metadata = frontmatter.get("metadata")
    if isinstance(metadata, Mapping):
        short_description = str(metadata.get("short-description") or "").strip()
        if short_description:
            return short_description
    return str(frontmatter.get("description") or "").strip()


def product_metadata(directory: Path, row: Mapping[str, Any]) -> bytes:
    """One deterministic metadata format for compilation and offline verification."""
    frontmatter, _ = parse_skill_frontmatter(
        (directory / SKILL_MANIFEST_NAME).read_text(encoding="utf-8")
    )
    return json_bytes(
        {
            "version": row["version"],
            "origin": f"{SKILL_PACK_ORIGIN}:{row['namespace']}/{row['slug']}",
            "category": SKILL_PACK_CATEGORY,
            "blurb": _skill_blurb(directory, frontmatter),
            "icon": SKILL_PACK_ICON,
            "package_sha256": row["zip_sha256"],
            "manifest_sha256": row["manifest_sha256"],
            "fingerprint": row["fingerprint"],
        }
    )


def compile_bundled_skills(lock_path: Path, cache: Path, target: Path) -> SkillPackBuild:
    """Verify a complete frozen input set, then replace the pack without networking."""

    lock = load_lock(lock_path)
    verify_runtime_target(lock)
    target_root = target.expanduser().resolve()
    if target.expanduser().is_symlink():
        raise SkillPackError("技能 pack 目标不能是符号链接")
    for source in (lock_path.expanduser().resolve(), cache.expanduser().resolve()):
        if source == target_root or target_root in source.parents:
            raise SkillPackError("技能输入不能位于将被替换的目标目录内")
    if target_root.exists():
        if not target_root.is_dir() or any(
            child.is_symlink()
            or not child.is_dir()
            or not (child / SKILL_PRODUCT_METADATA_FILE).is_file()
            for child in target_root.iterdir()
        ):
            raise SkillPackError("拒绝替换含非技能数据的目标目录")
    target_root.parent.mkdir(parents=True, exist_ok=True)
    names = frozenset(row["slug"] for row in lock["skills"])
    with tempfile.TemporaryDirectory(
        prefix="scholarseed-skill-pack-", dir=target_root.parent
    ) as temporary:
        pack = Path(temporary) / target_root.name
        pack.mkdir()
        for row in lock["skills"]:
            archive = cache_path(cache, row)
            if (
                archive.is_symlink()
                or not archive.is_file()
                or archive.stat().st_size > MAX_PACKAGE_BYTES
            ):
                raise SkillPackError(f"无效或缺失的锁定 ZIP: {row['slug']}")
            package = package_for(row, archive.read_bytes())
            if SKILL_PRODUCT_METADATA_FILE in package.files:
                raise SkillPackError("技能包不得携带编译器保留的产品元数据")
            directory = pack / package.name
            extract_package(package, directory)
            metadata_path = directory / SKILL_PRODUCT_METADATA_FILE
            metadata_path.write_bytes(product_metadata(directory, row))
            metadata_path.chmod(FILE_MODE)
        validation = validate_bundled_skills(pack, expected=names)
        if not validation.ok:
            raise SkillPackError(str(dict(validation.errors)))
        previous = Path(temporary) / "previous"
        if target_root.exists():
            target_root.rename(previous)
        try:
            pack.rename(target_root)
        except BaseException:
            if previous.exists():
                previous.rename(target_root)
            raise
    return SkillPackBuild(
        packages=tuple(
            f"{row['namespace']}/{row['slug']}@{row['version']}" for row in lock["skills"]
        ),
        skills=tuple(sorted(names)),
    )


def _installed_mode(mode: int) -> int:
    """Project archive and disk modes onto permissions the host can preserve.

    Windows chmod only changes the read-only attribute; CRT executable bits may
    come from the filename extension and cannot attest a ZIP's POSIX execute bit.
    The original mode remains authenticated in the lock and package manifest.
    """
    if os.name == WINDOWS_PLATFORM:
        return FILE_MODE if mode & stat.S_IWRITE else FILE_MODE & ~stat.S_IWRITE
    return EXECUTABLE_MODE if mode & stat.S_IXUSR else FILE_MODE


def _payload_fingerprints(root: Path) -> dict[str, tuple[str, int, int]]:
    fingerprints: dict[str, tuple[str, int, int]] = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise SkillPackError(f"技能产物包含符号链接: {relative.as_posix()}")
        if path.is_file():
            data = path.read_bytes()
            fingerprints[relative.as_posix()] = (
                sha256(data).hexdigest(),
                len(data),
                _installed_mode(path.stat().st_mode),
            )
        elif not path.is_dir():
            raise SkillPackError(f"技能产物包含特殊文件: {relative.as_posix()}")
    return fingerprints


def verify_bundled_skill_sources(lock_path: Path, cache: Path, target: Path) -> SkillPackValidation:
    """Read-only byte/size/mode comparison against the exact frozen input set."""

    if target.expanduser().is_symlink():
        raise SkillPackError("技能 pack 目标不能是符号链接")
    target_root = target.expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="scholarseed-skill-verify-") as temporary:
        expected_root = Path(temporary) / "skills"
        built = compile_bundled_skills(lock_path, cache, expected_root)
        validation = validate_bundled_skills(target_root, expected=frozenset(built.skills))
        expected_files = _payload_fingerprints(expected_root)
        actual_files = _payload_fingerprints(target_root)
    differences: list[str] = []
    for name in sorted(expected_files.keys() - actual_files.keys()):
        differences.append(f"missing bundled file: {name}")
    for name in sorted(actual_files.keys() - expected_files.keys()):
        differences.append(f"unexpected bundled file: {name}")
    for name in sorted(expected_files.keys() & actual_files.keys()):
        if expected_files[name] != actual_files[name]:
            differences.append(f"changed bundled file: {name}")
    errors = dict(validation.errors)
    if differences:
        errors[PACK_VALIDATION_KEY] = (
            *errors.get(PACK_VALIDATION_KEY, ()),
            *differences,
        )
    return SkillPackValidation(discovered=validation.discovered, errors=errors)


def verify_locked_pack(lock_path: Path, target: Path) -> SkillPackValidation:
    """Verify an installed app without cache, registry, source checkout or credentials.

    The artifact driver additionally checks this embedded lock's SHA against its
    externally frozen input. A self-reported lock alone is not provenance proof.
    """
    if target.is_symlink():
        raise SkillPackError("技能 pack 目标不能是符号链接")
    lock = load_lock(lock_path)
    verify_runtime_target(lock)
    validation = validate_bundled_skills(
        target, expected=frozenset(row["slug"] for row in lock["skills"])
    )
    expected: dict[str, tuple[str, int, int]] = {}
    for row in lock["skills"]:
        manifest_path = target / row["slug"] / PACKAGE_MANIFEST
        if manifest_path.is_file() and not manifest_path.is_symlink():
            manifest_data = manifest_path.read_bytes()
            manifest = json.loads(manifest_data)
            payload = [item for item in row["files"] if item["path"] != PACKAGE_MANIFEST]
            if (
                digest(manifest_data) != row["manifest_sha256"]
                or manifest.get("name") != row["slug"]
                or manifest.get("version") != row["version"]
                or manifest.get("dependencies") != row["dependencies"]
                or sorted(manifest.get("files", []), key=lambda item: item["path"])
                != sorted(payload, key=lambda item: item["path"])
            ):
                raise SkillPackError(f"锁行与包内清单不一致: {row['slug']}")
        for item in row["files"]:
            expected[f"{row['slug']}/{item['path']}"] = (
                item["sha256"],
                item["size"],
                _installed_mode(item["mode"]),
            )
        directory = target / row["slug"]
        if (directory / SKILL_MANIFEST_NAME).is_file():
            metadata = product_metadata(directory, row)
            expected[f"{row['slug']}/{SKILL_PRODUCT_METADATA_FILE}"] = (
                digest(metadata),
                len(metadata),
                FILE_MODE,
            )
    actual = _payload_fingerprints(target)
    differences = tuple(
        f"locked payload differs: {path}"
        for path in sorted(expected.keys() | actual.keys())
        if expected.get(path) != actual.get(path)
    )
    errors = dict(validation.errors)
    if differences:
        errors[PACK_VALIDATION_KEY] = (*errors.get(PACK_VALIDATION_KEY, ()), *differences)
    return SkillPackValidation(discovered=validation.discovered, errors=errors)


__all__ = [
    "SKILL_PACK_CATEGORY",
    "SkillPackBuild",
    "SkillPackError",
    "SkillPackValidation",
    "compile_bundled_skills",
    "validate_bundled_skills",
    "verify_bundled_skill_sources",
]
