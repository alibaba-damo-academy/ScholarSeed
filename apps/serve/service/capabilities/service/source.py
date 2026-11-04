"""从仓库内技能源码离线编译技能 pack —— 开源版取代 Skillhub 的构建输入。

开源后技能源码随仓库一起开源（``skills/community/``），因此构建期不再需要 Skillhub
的版本解析、ZIP 下载与安全审计证据。本模块提供与原 Skillhub 路径**同等强度**的
完整性保证：

- ``skills.lock.json`` 由仓库内源码**生成**（记录 slug/version/逐文件 sha256 与
  mode），而不是记录 Hub 版本与扫描结果；
- 编译走临时目录 + 原子替换，失败回滚；
- exact-set 校验：产出集合必须与源码目录声明的一致，不多不少；
- 恢复文件权限（普通 0644 / 可执行 0755）；
- 生成 ``.scholarseed.json`` 产品元数据；
- 全程离线：不联网、不读缓存 ZIP、不回退到任何外部来源。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from uuid import uuid4

from service.capabilities.domain import SKILL_MANIFEST_NAME
from service.capabilities.service.install import parse_skill_frontmatter
from service.capabilities.service.manifest import atomic_write
from service.capabilities.service.package import (
    DIRECTORY_PROVENANCE_KIND,
    MAX_FILE_BYTES,
    PACKAGE_MANIFEST,
    VERSION_PATTERN,
    declaration,
    digest,
    json_bytes,
    package_manifest,
    validate_paths,
)
from service.capabilities.service.prebundle import (
    PACK_VALIDATION_KEY,
    SKILL_PACK_CATEGORY,
    SKILL_PACK_ICON,
    SkillPackBuild,
    SkillPackError,
    SkillPackValidation,
    validate_bundled_skills,
)
from service.capabilities.service.skills import (
    SKILL_CATEGORY_SOURCE_KEY,
    SKILL_INVOCATION_METADATA_KEY,
    SKILL_INVOCATION_PERMISSION_DEFAULT,
    SKILL_INVOCATION_PERMISSION_FULL_ACCESS,
    SKILL_INVOCATION_PERMISSION_KEY,
    SKILL_INVOCATION_POLICY_FIELDS,
    SKILL_INVOCATION_PROFILE_FIELDS,
    SKILL_INVOCATION_PROFILE_PATTERN,
    SKILL_INVOCATION_PROFILES_KEY,
    SKILL_PRODUCT_METADATA_FILE,
    SKILL_SOURCE_BUILTIN,
)
from service.platform.storage import filesystem_path

# 开源仓库内技能源码根：<repo>/skills/community。
# service/capabilities/service/source.py -> service/capabilities/service
#   -> service/capabilities -> service -> apps/serve -> apps -> <repo root>
REPO_ROOT = Path(__file__).resolve().parents[5]
COMMUNITY_SKILLS_DIR = REPO_ROOT / "skills" / "community"
SKILLS_LOCK_FILE = REPO_ROOT / "skills" / "skills.lock.json"
PRODUCT_DEFAULTS_DIR = Path(__file__).resolve().parents[1] / "defaults"

WINDOWS_PLATFORM = "win32"
PACK_STAGING_PREFIX = "scholarseed-skill-pack-"

LOCK_PROTOCOL_VERSION = 3
LOCK_SOURCE = "repository"
BUNDLED_INVENTORY_KEY = "inventory"
SKILL_PACK_ORIGIN_SOURCE = "repository"
COMMUNITY_NAMESPACE = "scholarseed"
DEFAULT_SKILL_VERSION = "0.0.0"
SKILL_VERSION_FILE = "VERSION"
SKILL_REGISTRY_FILE = "registry.json"
SKILL_DEPENDENCIES_KEY = "dependencies"
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755
DIRECTORY_MODE = 0o755
TEXT_ENCODING = "utf-8"
CHUNK_BYTES = 1024 * 1024
HASH_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
SOURCE_LOCK_FIELDS = frozenset({"protocol_version", "source", "namespace", "skills"})
SOURCE_SKILL_FIELDS = frozenset(
    {"slug", "namespace", "version", "payload_sha256", "files", SKILL_DEPENDENCIES_KEY}
)
SOURCE_FILE_FIELDS = frozenset({"path", "size", "sha256", "mode"})
# 源码目录里不属于技能负载的开发残留，不进 pack。
EXCLUDED_NAMES = frozenset({"__pycache__", ".DS_Store", ".git", ".pytest_cache"})
EXCLUDED_SUFFIXES = (".pyc", ".pyo")


@dataclass(frozen=True)
class SkillSourceFile:
    """源码目录里一个参与打包的文件。"""

    relative: str
    size: int
    sha256: str
    executable: bool


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _portable_mode(path: Path) -> int:
    return EXECUTABLE_MODE if path.stat().st_mode & stat.S_IXUSR else FILE_MODE


def _included(path: Path, root: Path) -> bool:
    relative_parts = path.relative_to(root).parts
    if any(part in EXCLUDED_NAMES for part in relative_parts):
        return False
    if path.name.endswith(EXCLUDED_SUFFIXES):
        return False
    # 产品元数据由编译器生成，源码不得自带（否则会被静默覆盖而无人察觉）。
    return path.relative_to(root).as_posix() != SKILL_PRODUCT_METADATA_FILE


def skill_source_files(directory: Path) -> tuple[SkillSourceFile, ...]:
    """列出一个技能源码目录里参与打包的全部文件（稳定排序）。"""

    root = filesystem_path(directory).resolve()
    rows: list[SkillSourceFile] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_symlink() or path.is_junction():
            raise SkillPackError(f"技能源码不得包含符号链接: {path.relative_to(root)}")
        if not path.is_file() and not path.is_dir():
            raise SkillPackError(f"技能源码不得包含特殊文件: {path.relative_to(root)}")
        if not path.is_file() or not _included(path, root):
            continue
        rows.append(
            SkillSourceFile(
                relative=path.relative_to(root).as_posix(),
                size=path.stat().st_size,
                sha256=_sha256(path),
                executable=bool(path.stat().st_mode & stat.S_IXUSR),
            )
        )
    return tuple(rows)


def _product_default_files(
    name: str,
    source_files: tuple[SkillSourceFile, ...],
    defaults: Path | None = None,
) -> tuple[SkillSourceFile, ...]:
    """Return product-owned runtime defaults without changing skill source trees."""

    root = filesystem_path((defaults or PRODUCT_DEFAULTS_DIR).expanduser()).resolve() / name
    if not root.is_dir():
        return ()
    source_paths = {row.relative for row in source_files}
    rows = skill_source_files(root)
    collisions = sorted(source_paths & {row.relative for row in rows})
    if collisions:
        raise SkillPackError(f"产品默认文件不得覆盖技能源码: {name}/" + ", ".join(collisions))
    return rows


def _effective_files(
    directory: Path,
    name: str,
    defaults: Path | None = None,
) -> tuple[SkillSourceFile, ...]:
    source_files = skill_source_files(directory)
    return tuple(
        sorted(
            (*source_files, *_product_default_files(name, source_files, defaults)),
            key=lambda row: row.relative,
        )
    )


def discover_source_skills(source: Path = COMMUNITY_SKILLS_DIR) -> tuple[str, ...]:
    """发现源码根下的技能目录。空目录是构建缺陷，显式失败而不是产出空包。"""

    root = filesystem_path(source.expanduser()).resolve()
    if not root.is_dir():
        raise SkillPackError(f"技能源码根不存在: {root}")
    names = tuple(
        sorted(
            child.name
            for child in root.iterdir()
            if child.is_dir()
            and not child.is_symlink()
            and child.name not in EXCLUDED_NAMES
            and (child / SKILL_MANIFEST_NAME).is_file()
        )
    )
    if not names:
        raise SkillPackError(f"技能源码根下没有任何带 {SKILL_MANIFEST_NAME} 的技能: {root}")
    return names


def _skill_version(directory: Path, frontmatter: Mapping[str, Any]) -> str:
    metadata = frontmatter.get("metadata")
    version = ""
    if isinstance(metadata, Mapping):
        version = str(metadata.get("version") or "").strip()
    if not version:
        version = str(frontmatter.get("version") or "").strip() or DEFAULT_SKILL_VERSION
    version_file = directory / SKILL_VERSION_FILE
    if version_file.is_file():
        declared = version_file.read_text(encoding=TEXT_ENCODING).strip()
        if declared != version:
            raise SkillPackError(
                f"{directory.name}: {SKILL_VERSION_FILE} version {declared!r} "
                f"differs from {SKILL_MANIFEST_NAME} version {version!r}"
            )
    return version


def _skill_blurb(frontmatter: Mapping[str, Any]) -> str:
    metadata = frontmatter.get("metadata")
    if isinstance(metadata, Mapping):
        short_description = str(metadata.get("short-description") or "").strip()
        if short_description:
            return short_description
    return str(frontmatter.get("description") or "").strip()


def _invocation_policy(frontmatter: Mapping[str, Any]) -> dict[str, Any]:
    metadata = frontmatter.get("metadata")
    raw = metadata.get(SKILL_INVOCATION_METADATA_KEY) if isinstance(metadata, Mapping) else None
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise SkillPackError("技能 invocation policy 非法")
    if set(raw) == SKILL_INVOCATION_POLICY_FIELDS:
        if raw.get(SKILL_INVOCATION_PERMISSION_KEY) != SKILL_INVOCATION_PERMISSION_FULL_ACCESS:
            raise SkillPackError("技能 invocation policy 非法")
        return {SKILL_INVOCATION_PERMISSION_KEY: SKILL_INVOCATION_PERMISSION_FULL_ACCESS}
    if set(raw) != SKILL_INVOCATION_PROFILE_FIELDS:
        raise SkillPackError("技能 invocation policy 非法")
    profiles = raw.get(SKILL_INVOCATION_PROFILES_KEY)
    if not isinstance(profiles, Mapping) or not profiles:
        raise SkillPackError("技能 invocation profiles 非法")
    normalized: dict[str, dict[str, str]] = {}
    allowed_permissions = {
        SKILL_INVOCATION_PERMISSION_DEFAULT,
        SKILL_INVOCATION_PERMISSION_FULL_ACCESS,
    }
    for name, policy in profiles.items():
        if (
            not isinstance(name, str)
            or SKILL_INVOCATION_PROFILE_PATTERN.fullmatch(name) is None
            or not isinstance(policy, Mapping)
            or set(policy) != SKILL_INVOCATION_POLICY_FIELDS
            or policy.get(SKILL_INVOCATION_PERMISSION_KEY) not in allowed_permissions
        ):
            raise SkillPackError("技能 invocation profiles 非法")
        normalized[name] = {
            SKILL_INVOCATION_PERMISSION_KEY: str(policy[SKILL_INVOCATION_PERMISSION_KEY])
        }
    return {SKILL_INVOCATION_PROFILES_KEY: normalized}


def _frontmatter(directory: Path) -> Mapping[str, Any]:
    manifest = directory / SKILL_MANIFEST_NAME
    frontmatter, _ = parse_skill_frontmatter(manifest.read_text(encoding=TEXT_ENCODING))
    return frontmatter if isinstance(frontmatter, Mapping) else {}


def _bundled_manifest(row: Mapping[str, Any]) -> bytes:
    document = next(item for item in row["files"] if item["path"] == SKILL_MANIFEST_NAME)
    return package_manifest(
        row["slug"],
        row["version"],
        {"kind": DIRECTORY_PROVENANCE_KIND},
        document["sha256"],
        row[SKILL_DEPENDENCIES_KEY],
        row["files"],
    )


def _payload_digest(files: list[dict[str, Any]], dependencies: Mapping[str, Any]) -> str:
    payload_digest = hashlib.sha256(json_bytes(dependencies))
    for item in files:
        payload_digest.update(item["path"].encode(TEXT_ENCODING))
        payload_digest.update(item["sha256"].encode(TEXT_ENCODING))
    return payload_digest.hexdigest()


def source_lock(source: Path = COMMUNITY_SKILLS_DIR) -> dict[str, Any]:
    """由仓库内技能源码生成 lock —— 开源版构建输入的权威记录。

    与 Skillhub 版 lock 的区别：``source`` 为 ``repository``，不含 Hub 版本 id、
    ZIP 摘要与安全扫描证据；改为记录逐文件 sha256/size/mode，用于打包期冻结校验
    与产物比对。
    """

    root = filesystem_path(source.expanduser()).resolve()
    registry = json.loads((root.parent / SKILL_REGISTRY_FILE).read_bytes())
    policies = registry.get(SKILL_DEPENDENCIES_KEY) if isinstance(registry, dict) else None
    if not isinstance(policies, dict):
        raise SkillPackError(f"{SKILL_REGISTRY_FILE} must declare skill dependencies")
    rows: list[dict[str, Any]] = []
    for name in discover_source_skills(root):
        directory = root / name
        frontmatter = _frontmatter(directory)
        version = _skill_version(directory, frontmatter)
        if frontmatter.get("name") != name:
            raise SkillPackError(
                f"{name}: {SKILL_MANIFEST_NAME} name differs from source directory"
            )
        if name not in policies:
            raise SkillPackError(f"{name}: missing dependency policy in {SKILL_REGISTRY_FILE}")
        dependencies = declaration(policies[name])
        files = [
            {
                "path": row.relative,
                "size": row.size,
                "sha256": row.sha256,
                "mode": EXECUTABLE_MODE if row.executable else FILE_MODE,
            }
            for row in _effective_files(directory, name)
        ]
        rows.append(
            {
                "slug": name,
                "namespace": COMMUNITY_NAMESPACE,
                "version": version,
                "payload_sha256": _payload_digest(files, dependencies),
                "files": files,
                SKILL_DEPENDENCIES_KEY: dependencies,
            }
        )
    return validate_source_lock(
        {
            "protocol_version": LOCK_PROTOCOL_VERSION,
            "source": LOCK_SOURCE,
            "namespace": COMMUNITY_NAMESPACE,
            "skills": rows,
        }
    )


def validate_source_lock(lock: dict[str, Any]) -> dict[str, Any]:
    """Validate the repository-source lock without accepting a Skillhub lock."""

    try:
        if (
            set(lock) != SOURCE_LOCK_FIELDS
            or lock["protocol_version"] != LOCK_PROTOCOL_VERSION
            or lock["source"] != LOCK_SOURCE
            or lock["namespace"] != COMMUNITY_NAMESPACE
        ):
            raise SkillPackError("invalid repository skill lock header")
        rows = lock["skills"]
        if not isinstance(rows, list) or not rows:
            raise SkillPackError("repository skill lock cannot be empty")
        slugs = [row["slug"] for row in rows]
        validate_paths(slugs)
        if len(set(slugs)) != len(slugs):
            raise SkillPackError("duplicate repository skill lock entry")
        for row in rows:
            if (
                set(row) != SOURCE_SKILL_FIELDS
                or row["namespace"] != lock["namespace"]
                or "/" in row["slug"]
                or not VERSION_PATTERN.fullmatch(row["version"])
                or not HASH_PATTERN.fullmatch(row["payload_sha256"])
            ):
                raise SkillPackError("invalid repository skill lock identity")
            files = row["files"]
            if not isinstance(files, list) or not files:
                raise SkillPackError("repository skill lock requires a file inventory")
            paths = [item["path"] for item in files]
            validate_paths(paths)
            if (
                paths != sorted(paths)
                or len(set(paths)) != len(paths)
                or PACKAGE_MANIFEST in paths
                or SKILL_MANIFEST_NAME not in paths
            ):
                raise SkillPackError("invalid repository skill file inventory")
            dependencies = declaration(row[SKILL_DEPENDENCIES_KEY])
            for item in files:
                if (
                    set(item) != SOURCE_FILE_FIELDS
                    or not isinstance(item["size"], int)
                    or isinstance(item["size"], bool)
                    or not 0 <= item["size"] <= MAX_FILE_BYTES
                    or item["mode"] not in {FILE_MODE, EXECUTABLE_MODE}
                    or not HASH_PATTERN.fullmatch(item["sha256"])
                ):
                    raise SkillPackError("invalid repository skill file record")
            if _payload_digest(files, dependencies) != row["payload_sha256"]:
                raise SkillPackError("repository skill payload digest differs")
    except (KeyError, TypeError, AttributeError) as exc:
        raise SkillPackError("invalid repository skill lock schema") from exc
    return lock


def load_source_lock(path: Path) -> dict[str, Any]:
    """Load the lock format generated from ``skills/community``."""

    try:
        value = json.loads(filesystem_path(path.expanduser()).read_bytes())
    except (OSError, json.JSONDecodeError) as exc:
        raise SkillPackError("invalid repository skill lock") from exc
    if not isinstance(value, dict):
        raise SkillPackError("invalid repository skill lock schema")
    return validate_source_lock(value)


def write_source_lock(
    destination: Path = SKILLS_LOCK_FILE, source: Path = COMMUNITY_SKILLS_DIR
) -> Path:
    """把源码 lock 原子写入磁盘，供打包期冻结与产物比对使用。"""

    destination = filesystem_path(destination.expanduser())
    atomic_write(destination, json_bytes(source_lock(source)))
    return destination.expanduser().resolve()


def product_metadata_from_source(directory: Path, row: Mapping[str, Any]) -> bytes:
    """产品元数据的唯一确定格式（编译与离线校验共用）。"""

    frontmatter = _frontmatter(directory)
    payload = {
        "version": row["version"],
        "origin": f"{SKILL_PACK_ORIGIN_SOURCE}:{row['namespace']}/{row['slug']}",
        "category": SKILL_PACK_CATEGORY,
        SKILL_CATEGORY_SOURCE_KEY: SKILL_SOURCE_BUILTIN,
        "blurb": _skill_blurb(frontmatter),
        "icon": SKILL_PACK_ICON,
        "payload_sha256": row["payload_sha256"],
        BUNDLED_INVENTORY_KEY: {
            "protocol_version": LOCK_PROTOCOL_VERSION,
            "source": LOCK_SOURCE,
            "namespace": COMMUNITY_NAMESPACE,
            "skills": [dict(row)],
        },
    }
    invocation = _invocation_policy(frontmatter)
    if invocation:
        payload[SKILL_INVOCATION_METADATA_KEY] = invocation
    return json_bytes(payload)


def verify_compiled_skill(directory: Path) -> Mapping[str, Any]:
    """Authorize exact compiled bytes against their build-frozen source inventory."""
    directory = filesystem_path(directory)
    if directory.is_symlink() or directory.is_junction():
        raise SkillPackError("bundled skill directory cannot be a link")
    metadata = json.loads((directory / SKILL_PRODUCT_METADATA_FILE).read_bytes())
    inventory = metadata.get(BUNDLED_INVENTORY_KEY) if isinstance(metadata, dict) else None
    if not isinstance(inventory, dict):
        raise SkillPackError("bundled skill inventory unavailable; rebuild the product pack")
    rows = validate_source_lock(inventory)["skills"]
    if len(rows) != 1:
        raise SkillPackError("bundled skill inventory identity differs")
    row: Mapping[str, Any] = rows[0]
    if (
        row["slug"] != directory.name
        or row["version"] != metadata.get("version")
        or row["payload_sha256"] != metadata.get("payload_sha256")
    ):
        raise SkillPackError("bundled skill inventory identity differs")
    expected = [(item["path"], item["size"], item["sha256"]) for item in _pack_file_records(row)]
    actual = [(item.relative, item.size, item.sha256) for item in skill_source_files(directory)]
    if actual != expected:
        raise SkillPackError("bundled skill integrity mismatch")
    return row


def _copy_payload(origin: Path, destination: Path, files: tuple[SkillSourceFile, ...]) -> None:
    for row in files:
        target = destination / row.relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((origin / row.relative).read_bytes())
        target.chmod(EXECUTABLE_MODE if row.executable else FILE_MODE)
    for path in sorted(destination.rglob("*")):
        if path.is_dir():
            path.chmod(DIRECTORY_MODE)


def _copy_product_defaults(name: str, destination: Path) -> None:
    origin = filesystem_path(PRODUCT_DEFAULTS_DIR.expanduser()) / name
    if not origin.is_dir():
        return
    _copy_payload(origin, destination, skill_source_files(origin))


@contextmanager
def _pack_staging(parent: Path) -> Iterator[Path]:
    if sys.platform != WINDOWS_PLATFORM:
        with tempfile.TemporaryDirectory(prefix=PACK_STAGING_PREFIX, dir=parent) as temporary:
            yield Path(temporary)
        return
    # Python's Windows 0700 temporary directories create a private DACL. A
    # rename preserves that ACL on descendants, and chmod cannot restore it.
    # This build staging contains public skill assets: inherit the destination
    # parent's policy at creation, without changing any existing object's ACL.
    temporary = parent / f"{PACK_STAGING_PREFIX}{uuid4().hex}"
    temporary.mkdir(mode=DIRECTORY_MODE)
    try:
        yield temporary
    finally:
        shutil.rmtree(temporary)


def compile_source_skills(
    target: Path,
    source: Path = COMMUNITY_SKILLS_DIR,
    *,
    lock_path: Path | None = None,
) -> SkillPackBuild:
    """从仓库内源码原子编译技能 pack。全程离线，无 Skillhub、无 ZIP 缓存。"""

    root = filesystem_path(source.expanduser()).resolve()
    target = filesystem_path(target.expanduser())
    target_root = target.resolve()
    if target.is_symlink() or target.is_junction():
        raise SkillPackError("技能 pack 目标不能是符号链接")
    if root == target_root or target_root in root.parents:
        raise SkillPackError("技能源码不能位于将被替换的目标目录内")
    if target_root.exists():
        if not target_root.is_dir() or any(
            child.is_symlink()
            or not child.is_dir()
            or not (child / SKILL_PRODUCT_METADATA_FILE).is_file()
            for child in target_root.iterdir()
        ):
            raise SkillPackError("拒绝替换含非技能数据的目标目录")
    lock = source_lock(root)
    if lock_path is not None:
        lock_path = filesystem_path(lock_path.expanduser())
        lock_destination = lock_path.resolve()
        if (
            lock_path.is_symlink()
            or lock_path.is_junction()
            or lock_destination.is_relative_to(root)
            or lock_destination.is_relative_to(target_root)
            or lock_destination == root.parent / SKILL_REGISTRY_FILE
        ):
            raise SkillPackError("技能 lock 输出不得覆盖源码、依赖政策或技能 pack")
    names = frozenset(row["slug"] for row in lock["skills"])
    target_root.parent.mkdir(parents=True, exist_ok=True)
    with _pack_staging(target_root.parent) as temporary:
        pack = temporary / target_root.name
        pack.mkdir()
        for row in lock["skills"]:
            origin = root / row["slug"]
            directory = pack / row["slug"]
            directory.mkdir()
            files = skill_source_files(origin)
            _copy_payload(origin, directory, files)
            _copy_product_defaults(row["slug"], directory)
            manifest_path = directory / PACKAGE_MANIFEST
            manifest_path.write_bytes(_bundled_manifest(row))
            manifest_path.chmod(FILE_MODE)
            metadata_path = directory / SKILL_PRODUCT_METADATA_FILE
            metadata_path.write_bytes(product_metadata_from_source(origin, row))
            metadata_path.chmod(FILE_MODE)
        validation = _verify_pack(lock, pack)
        if not validation.ok:
            raise SkillPackError(str(dict(validation.errors)))
        previous = temporary / "previous"
        if target_root.exists():
            target_root.rename(previous)
        try:
            pack.rename(target_root)
        except BaseException:
            if previous.exists():
                previous.rename(target_root)
            raise
    if lock_path is not None:
        atomic_write(lock_path, json_bytes(lock))
    return SkillPackBuild(
        packages=tuple(
            f"{row['namespace']}/{row['slug']}@{row['version']}" for row in lock["skills"]
        ),
        skills=tuple(sorted(names)),
    )


def _pack_file_records(row: Mapping[str, Any]) -> list[dict[str, Any]]:
    manifest = _bundled_manifest(row)
    return sorted(
        [
            *row["files"],
            {
                "path": PACKAGE_MANIFEST,
                "size": len(manifest),
                "sha256": digest(manifest),
                "mode": FILE_MODE,
            },
        ],
        key=lambda entry: entry["path"],
    )


def verify_source_pack(
    target: Path,
    source: Path = COMMUNITY_SKILLS_DIR,
) -> tuple[bool, tuple[str, ...]]:
    """Verify exact installed bytes, including the manifest derived from the source lock."""

    validation = _verify_pack(source_lock(source), target)
    return validation.ok, tuple(
        f"{name}: {error}" for name, errors in validation.errors.items() for error in errors
    )


def verify_source_locked_pack(lock_path: Path, target: Path) -> SkillPackValidation:
    """Verify an installed pack using only its frozen repository-source lock."""

    return _verify_pack(load_source_lock(lock_path), target)


def _verify_pack(lock: Mapping[str, Any], target: Path) -> SkillPackValidation:
    target = filesystem_path(target.expanduser())
    if target.is_symlink() or target.is_junction():
        raise SkillPackError("技能 pack 目标不能是符号链接")
    root = filesystem_path(target.expanduser().resolve())
    validation = validate_bundled_skills(
        root, expected=frozenset(row["slug"] for row in lock["skills"])
    )
    expected: dict[str, tuple[str, int, int]] = {}
    for row in lock["skills"]:
        for item in _pack_file_records(row):
            expected[f"{row['slug']}/{item['path']}"] = (
                item["sha256"],
                item["size"],
                item["mode"],
            )
        directory = root / row["slug"]
        if (directory / SKILL_MANIFEST_NAME).is_file():
            metadata = product_metadata_from_source(directory, row)
            expected[f"{row['slug']}/{SKILL_PRODUCT_METADATA_FILE}"] = (
                digest(metadata),
                len(metadata),
                FILE_MODE,
            )
    actual: dict[str, tuple[str, int, int]] = {}
    if root.is_dir():
        for path in root.rglob("*"):
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or path.is_junction():
                raise SkillPackError(f"技能产物包含符号链接: {relative}")
            if path.is_file():
                data = path.read_bytes()
                actual[relative] = (
                    digest(data),
                    len(data),
                    _portable_mode(path),
                )
            elif not path.is_dir():
                raise SkillPackError(f"技能产物包含特殊文件: {relative}")
    differences = tuple(
        f"locked repository payload differs: {path}"
        for path in sorted(expected.keys() | actual.keys())
        if expected.get(path) != actual.get(path)
    )
    errors = dict(validation.errors)
    if differences:
        errors[PACK_VALIDATION_KEY] = (
            *errors.get(PACK_VALIDATION_KEY, ()),
            *differences,
        )
    return SkillPackValidation(discovered=validation.discovered, errors=errors)


__all__ = [
    "COMMUNITY_SKILLS_DIR",
    "SKILLS_LOCK_FILE",
    "SkillSourceFile",
    "compile_source_skills",
    "discover_source_skills",
    "load_source_lock",
    "product_metadata_from_source",
    "skill_source_files",
    "verify_compiled_skill",
    "source_lock",
    "validate_source_lock",
    "verify_source_locked_pack",
    "verify_source_pack",
    "write_source_lock",
]
