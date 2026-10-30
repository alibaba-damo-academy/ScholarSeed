"""Safely install user-provided Agent Skills into the product-owned user root.

Archives are untrusted input: extraction prevents traversal and symlinks, enforces size limits,
and requires a portable ``SKILL.md``. The native Codex ``skills/list`` call is the final runtime
authority after installation; this module only validates and stores the package.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Dict, Optional
from uuid import uuid4

import yaml

from service.capabilities.domain import SKILL_MANIFEST_NAME
from service.platform.storage import open_directory, remove_tree

MAX_PACKAGE_BYTES = 20 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_DOCUMENT_BYTES = 512 * 1024
MAX_UPLOAD_ENTRIES = 5000
MACOS_METADATA_DIRECTORY = "__MACOSX"
MACOS_METADATA_FILE = ".DS_Store"
APPLEDOUBLE_PREFIX = "._"
#: 记录来源，供技能页区分「书深技能（hub 官方）」与「用户安装」。
ORIGIN_FILE_NAME = ".origin.json"
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
UPDATE_STAGING_PREFIX = ".skill-update-"
UPDATE_BACKUP_NAME = "previous"


class SkillPackageError(ValueError):
    """技能包不合法或不安全，拒绝安装。"""


class SkillDuplicateError(SkillPackageError):
    """已存在同名技能 (PRD 2.1.6 安装校验)。

    继承 SkillPackageError, 让路由层现有的 except 统一转成可读的 422;
    单独成类是为了前端将来能区分出「改名 / 覆盖」这条分支。
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"已存在相同标识的技能「{name}」，请调整技能标识后重新上传。")
        self.skill_name = name


@dataclass(frozen=True)
class InstalledSkill:
    name: str
    path: Path
    description: str

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "path": str(self.path), "description": self.description}


def _safe_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """只放行确定安全的成员：无绝对路径、无 `..`、无符号链接、总解压体积可控。"""

    members: list[zipfile.ZipInfo] = []
    total = 0
    seen: set[str] = set()
    if len(archive.infolist()) > MAX_UPLOAD_ENTRIES:
        raise SkillPackageError("技能包文件数量超出安全上限")
    for info in archive.infolist():
        name = info.filename
        if not name:
            raise SkillPackageError("技能包包含空路径")
        path = Path(name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or PureWindowsPath(name).drive
            or "\\" in name
            or ":" in name
            or "\x00" in name
            or any(
                part.endswith((" ", ".")) or PureWindowsPath(part).is_reserved()
                for part in path.parts
            )
        ):
            raise SkillPackageError(f"技能包包含非法路径: {name}")
        identity = name.rstrip("/").casefold()
        if identity in seen:
            raise SkillPackageError(f"技能包包含重复路径: {name}")
        seen.add(identity)
        kind = stat.S_IFMT(info.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1:
            raise SkillPackageError(f"技能包包含不支持的特殊或加密文件: {name}")
        if info.is_dir():
            continue
        # zip 用外部属性高 16 位存 Unix mode；0xA000 表示符号链接。
        if (info.external_attr >> 16) & 0xF000 == 0xA000:
            raise SkillPackageError(f"技能包包含符号链接: {name}")
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise SkillPackageError("技能包解压后体积超出上限")
        if (
            MACOS_METADATA_DIRECTORY in path.parts
            or path.name == MACOS_METADATA_FILE
            or path.name.startswith(APPLEDOUBLE_PREFIX)
        ):
            continue
        members.append(info)
    if not members:
        raise SkillPackageError("技能包为空")
    return members


def _manifest_root(staging: Path) -> Path:
    """定位含 SKILL.md 的目录：既接受根级 SKILL.md，也接受单层子目录包裹。"""

    candidates = sorted(staging.rglob(SKILL_MANIFEST_NAME))
    if len(candidates) != 1:
        raise SkillPackageError(f"技能包必须包含唯一的 {SKILL_MANIFEST_NAME}")
    root = candidates[0].parent
    if root == staging:
        return root
    if root.parent == staging and list(staging.iterdir()) == [root]:
        return root
    raise SkillPackageError(
        f"压缩包中缺少 {SKILL_MANIFEST_NAME} 文件，"
        f"请确保 zip 根目录或一级文件夹内包含 {SKILL_MANIFEST_NAME}。"
    )


def parse_skill_frontmatter(text: str) -> tuple[Dict[str, Any], str]:
    """Parse a portable Agent Skills header without importing a Python harness."""

    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return {}, text
    closing = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), -1)
    if closing < 0:
        return {}, text
    try:
        decoded = yaml.safe_load("".join(lines[1:closing])) or {}
    except yaml.YAMLError as exc:
        raise SkillPackageError(f"{SKILL_MANIFEST_NAME} 的 YAML 头信息无效: {exc}") from exc
    if not isinstance(decoded, dict):
        raise SkillPackageError(f"{SKILL_MANIFEST_NAME} 的 YAML 头信息必须是对象")
    return {str(key): value for key, value in decoded.items()}, "".join(lines[closing + 1 :])


def _skill_identity(manifest_path: Path, fallback: str) -> tuple[str, str]:
    text = manifest_path.read_text(encoding="utf-8", errors="replace")
    front, _ = parse_skill_frontmatter(text)
    if not front:
        # Codex relies on the portable frontmatter; reject a package it could not discover.
        raise SkillPackageError(
            f"{SKILL_MANIFEST_NAME} 缺少 YAML 头信息块"
            "（--- 开头和结尾的配置区域），请补充后重新上传。"
        )
    name = front.get("name")
    description = front.get("description")
    if not isinstance(name, str) or not isinstance(description, str) or not description.strip():
        raise SkillPackageError("技能名 name 与说明 description 必须是非空文本")
    name, description = name.strip(), description.strip()
    if not SKILL_NAME_PATTERN.fullmatch(name):
        raise SkillPackageError(f"技能名不合法: {name!r}")
    return name, description


def preview_skill_upload(payload: bytes, filename: str) -> dict[str, str]:
    if filename.lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                members = _safe_members(archive)
                manifests = [
                    item for item in members if Path(item.filename).name == SKILL_MANIFEST_NAME
                ]
                if len(manifests) != 1:
                    raise SkillPackageError(f"技能包必须包含唯一的 {SKILL_MANIFEST_NAME}")
                manifest = manifests[0]
                root = Path(manifest.filename).parent
                if len(root.parts) > 1 or any(
                    not Path(item.filename).is_relative_to(root) for item in members
                ):
                    raise SkillPackageError("SKILL.md 必须在根目录或唯一的一级文件夹内")
                if manifest.file_size > MAX_DOCUMENT_BYTES:
                    raise SkillPackageError("SKILL.md 超出说明文档安全上限")
                document = archive.read(manifest).decode("utf-8")
        except (zipfile.BadZipFile, RuntimeError, UnicodeError, OSError) as exc:
            raise SkillPackageError("技能包损坏或说明文件不是有效 UTF-8 文本") from exc
    elif filename.casefold() == SKILL_MANIFEST_NAME.casefold():
        if len(payload) > MAX_DOCUMENT_BYTES:
            raise SkillPackageError("SKILL.md 超出说明文档安全上限")
        try:
            document = payload.decode("utf-8")
        except UnicodeError as exc:
            raise SkillPackageError("SKILL.md 不是有效 UTF-8 文本") from exc
    else:
        raise SkillPackageError("只支持 SKILL.md 或 ZIP 技能包")
    metadata, body = parse_skill_frontmatter(document)
    if not metadata:
        raise SkillPackageError("SKILL.md 缺少有效 YAML 头信息块")
    name, description = metadata.get("name"), metadata.get("description")
    if not isinstance(name, str) or not SKILL_NAME_PATTERN.fullmatch(name):
        raise SkillPackageError("技能名 name 必填且必须是合法的稳定标识")
    if not isinstance(description, str) or not description.strip() or not body.strip():
        raise SkillPackageError("技能说明 description 与执行说明正文必填")
    return {
        "name": name,
        "description": description.strip(),
        "document": document,
        "version": str(metadata.get("version") or ""),
        "provider": str(metadata.get("author") or ""),
    }


def read_manifest_from_archive(payload: bytes) -> str:
    """从技能包里取出 `SKILL.md` 原文，供安装前审阅。取不到返回空串。"""

    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for entry in archive.namelist():
                if entry.endswith(SKILL_MANIFEST_NAME):
                    return archive.read(entry).decode("utf-8", errors="replace")
    except (zipfile.BadZipFile, OSError, KeyError):
        return ""
    return ""


def install_skill_archive(
    payload: bytes,
    skills_root: Path,
    *,
    fallback_name: str = "skill",
    origin: Optional[Dict[str, Any]] = None,
    overwrite: bool = False,
    reserved_names: frozenset[str] = frozenset(),
) -> InstalledSkill:
    """把技能包 zip 安装到 `skills_root/<name>/`，返回安装结果。

    技能名是唯一标识, 同名会让 Codex 的发现结果不确定, 因此默认拒绝并抛
    `SkillDuplicateError` 让用户决定改名还是覆盖 (PRD 2.1.6); `overwrite=True` 才替换。
    """

    if not payload:
        raise SkillPackageError("技能包内容为空")

    with tempfile.TemporaryDirectory(prefix="scholarseed-skill-") as tmp:
        staging = Path(tmp) / "staging"
        staging.mkdir(parents=True)
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                for info in _safe_members(archive):
                    destination = staging / info.filename
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, destination.open("wb") as sink:
                        shutil.copyfileobj(source, sink, length=1024 * 64)
        except zipfile.BadZipFile as exc:
            raise SkillPackageError("技能包不是合法的 zip") from exc

        root = _manifest_root(staging)
        name, description = _skill_identity(root / SKILL_MANIFEST_NAME, fallback_name)
        if name in reserved_names:
            raise SkillDuplicateError(name)
        if origin is not None:
            (root / ORIGIN_FILE_NAME).write_text(
                json.dumps(origin, ensure_ascii=False), encoding="utf-8"
            )

        target = skills_root / name
        skills_root.mkdir(parents=True, exist_ok=True)
        if target.exists() and not overwrite:
            raise SkillDuplicateError(name)
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(root), str(target))
        return InstalledSkill(name=name, path=target, description=description)


def read_skill_origin(skills_root: Path, name: str) -> Dict[str, Any]:
    if not SKILL_NAME_PATTERN.fullmatch(name):
        raise SkillPackageError("Invalid installed skill name")
    directory = open_directory(skills_root, (name,))
    try:
        descriptor = directory.open_regular(ORIGIN_FILE_NAME)
        with os.fdopen(descriptor, "r", encoding="utf-8") as document:
            origin = json.loads(document.read(MAX_DOCUMENT_BYTES + 1))
        if not isinstance(origin, dict):
            raise SkillPackageError("Invalid installed skill origin")
        return origin
    finally:
        directory.close()


def update_skill_archive(
    payload: bytes,
    skills_root: Path,
    *,
    name: str,
    expected_origin: Dict[str, Any],
    origin: Dict[str, Any],
) -> InstalledSkill:
    """Validate a same-identity replacement, keeping the old tree on publish failure."""
    if not SKILL_NAME_PATTERN.fullmatch(name):
        raise SkillPackageError("Invalid installed skill name")
    staging_name = UPDATE_STAGING_PREFIX + uuid4().hex
    parent = open_directory(skills_root, ())
    staging = None
    retired = False
    published = False
    try:
        previous = parent.directory(name)
        try:
            observed = read_skill_origin(skills_root, name)
            if observed != expected_origin:
                raise SkillPackageError("Installed skill changed; check for updates again")
            previous_identity = previous.identity()
        finally:
            previous.close()
        parent.mkdir(staging_name)
        staging = parent.directory(staging_name)
        staged = install_skill_archive(payload, staging.path, origin=origin)
        if staged.name != name:
            raise SkillPackageError("Updated package changed the installed skill name")
        latest = parent.stat(name)
        if (latest.st_dev, latest.st_ino) != previous_identity or read_skill_origin(
            skills_root, name
        ) != expected_origin:
            raise SkillPackageError("Installed skill changed during update")
        parent.rename_directory(name, staging_name + UPDATE_BACKUP_NAME)
        retired = True
        try:
            staging.rename_directory(name, name, destination_directory=parent)
            published = True
        except OSError:
            parent.rename_directory(staging_name + UPDATE_BACKUP_NAME, name)
            retired = False
            raise
        return InstalledSkill(name=name, path=skills_root / name, description=staged.description)
    except (OSError, ValueError) as exc:
        raise SkillPackageError(str(exc)) from exc
    finally:
        try:
            if staging is not None:
                staging.close()
                if not retired or published:
                    remove_tree(skills_root, (staging_name,))
            if published:
                remove_tree(skills_root, (staging_name + UPDATE_BACKUP_NAME,))
        finally:
            parent.close()


def install_skill_document(
    text: str, skills_root: Path, *, fallback_name: str = "skill", overwrite: bool = False
) -> InstalledSkill:
    """安装单个 `SKILL.md`（上传裸文件或从 GitHub 读到的内容）。"""

    if not text.strip():
        raise SkillPackageError("SKILL.md 内容为空")
    document_bytes = len(text.encode("utf-8"))
    if document_bytes > MAX_DOCUMENT_BYTES:
        raise SkillPackageError(f"SKILL.md 超过 {MAX_DOCUMENT_BYTES} 字节上限")
    with tempfile.TemporaryDirectory(prefix="scholarseed-skilldoc-") as tmp:
        staging = Path(tmp) / "skill"
        staging.mkdir(parents=True)
        manifest = staging / SKILL_MANIFEST_NAME
        manifest.write_text(text, encoding="utf-8")
        name, description = _skill_identity(manifest, fallback_name)
        target = skills_root / name
        skills_root.mkdir(parents=True, exist_ok=True)
        if target.exists() and not overwrite:
            raise SkillDuplicateError(name)
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(staging), str(target))
        return InstalledSkill(name=name, path=target, description=description)
