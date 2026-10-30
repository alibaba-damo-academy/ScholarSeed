"""Stage global literature attachments and roll back unpublished imports."""

from __future__ import annotations

import os
import re
import shutil
import stat
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import md5, sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TypeVar
from uuid import uuid4

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.storage import (
    FILE_ATTRIBUTE_REPARSE_POINT,
    NOFOLLOW,
    NONBLOCK,
    WINDOWS_PLATFORM,
    canonical_root,
    filesystem_path,
    open_directory,
)

BATCH_NOT_OPEN = "literature_file_batch_not_open"
INVALID_NAME = "literature_attachment_name_invalid"
INVALID_RELATIVE_PATH = "literature_relative_path_invalid"
ROOT_WORKSPACE = "."
# 修订号词法的唯一属主: 附件行、CAS 的 If-Match 与全文索引缓存的键都用它。
REVISION_PREFIX = "sha256:"
MAX_OWNER_TOKEN_CHARS = 64
OWNER_TOKEN = re.compile(rf"[A-Za-z0-9_-]{{1,{MAX_OWNER_TOKEN_CHARS}}}")
T = TypeVar("T")


@dataclass(frozen=True)
class ManagedObject:
    """一份独占附件副本的落盘名与它这批字节的内容修订号。"""

    name: str
    revision: str


def payload_revision(payload: bytes) -> str:
    """Content revision of exact bytes: the key of every derived full-text index."""
    return f"{REVISION_PREFIX}{sha256(payload).hexdigest()}"


def managed_object(literature_id: str, payload: bytes, suffix: str) -> ManagedObject:
    """Name one attachment file that exactly one literature item owns.

    名字是 ``{owner_token}-{md5}-{uuid}.{ext}``: 谁的 (owner_token)、哪一版
    字节 (md5)、哪一次写入 (uuid)。于是同一份 PDF 被两条文献导入会各存一份, 删
    一条绝不会掏空另一条的全文 —— 内容寻址时代的"同字节同文件"以及为它存在的
    全局引用计数一起消失。md5 只负责让人一眼看出"内容变了名字就变", 唯一性由
    uuid 保证, 不承担安全职责。

    owner_token 保留短 ASCII 属主 ID, 其他 ID 使用完整 sha256 编码, 避免把业务
    标识符中的冒号、Unicode 或超长文本当作跨平台文件名; 原始 ID 仍由目录表保存。

    ``revision`` 仍是 sha256, 与全文索引缓存和 CAS 的 If-Match 同一口径; 调用方
    必须把它写进附件行, 因为删除那一刻文件已经 unlink, 再也没有别的地方能反推出
    该忘掉哪一份索引。``suffix`` 是调用方已校验过的扩展名, 展示名留在附件行里。
    """
    # 托管目录只接受扁平文件名 (read_attachment 就守在这条边界上), 而 literature_id
    # 来自调用方, 不能假设它一定是干净的 uuid。
    if (
        not literature_id
        or literature_id in {".", ".."}
        or any(separator in literature_id for separator in ("/", "\\", "\x00"))
    ):
        raise ValueError(INVALID_NAME)
    owner = (
        literature_id
        if OWNER_TOKEN.fullmatch(literature_id)
        else sha256(literature_id.encode("utf-8")).hexdigest()
    )
    digest = md5(payload, usedforsecurity=False).hexdigest()
    return ManagedObject(
        name=f"{owner}-{digest}-{uuid4().hex}{suffix}",
        revision=payload_revision(payload),
    )


def is_available_attachment(location: str) -> bool:
    """Report whether the bytes behind an attachment row are still reachable.

    Only the literature-owned store is checked here: a managed path is ours to
    stat, while asset-backed and project-relative locations belong to Content,
    which raises its own ``file_not_found`` when they go missing.
    """
    if not location or not is_managed_attachment(location):
        return True
    return filesystem_path(location).is_file()


def attachment_size(location: str) -> int | None:
    """Return the on-disk byte size of a managed attachment, None when unknown.

    The row carries no size column, so the catalogue projects the real stat at
    read time; asset-backed and project-relative locations belong to Content
    and report no size here rather than guessing.
    """
    if not location or not is_managed_attachment(location):
        return None
    try:
        metadata = filesystem_path(location).stat()
    except OSError:
        return None
    if not stat.S_ISREG(metadata.st_mode):
        return None
    return metadata.st_size


def scoped_relative(*values: str) -> str:
    """Compose a relative storage path inside the persistence boundary."""
    path = Path()
    for value in values:
        if not isinstance(value, str) or not value:
            raise ValueError(INVALID_RELATIVE_PATH)
        part = Path(value)
        if part.is_absolute() or not part.parts or ".." in part.parts:
            raise ValueError(INVALID_RELATIVE_PATH)
        path /= part
    if not path.parts:
        raise ValueError(INVALID_RELATIVE_PATH)
    return path.as_posix()


def scoped_workspace(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(INVALID_RELATIVE_PATH)
    if Path(value) == Path(ROOT_WORKSPACE):
        return ROOT_WORKSPACE
    return scoped_relative(value)


def scoped_workspace_path(workspace: str, *values: str) -> str:
    relative = scoped_workspace(workspace)
    return (
        scoped_relative(*values)
        if relative == ROOT_WORKSPACE
        else scoped_relative(relative, *values)
    )


def scoped_parent(value: str) -> str:
    """Return the parent of a validated relative storage path."""
    return str(Path(scoped_relative(value)).parent)


def read_attachment(location: str) -> bytes:
    """Only a catalogue-owned managed attachment can cross this storage boundary."""
    root = SERVICE_LITERATURE_FILES_DIR.resolve()
    path = Path(location)
    # LiteratureFileBatch admits only flat file names. Keep reads inside that
    # same boundary, using a directory descriptor so a symlink cannot redirect it.
    if not path.is_absolute() or path.parent.resolve() != root or path.is_symlink():
        raise ValueError(INVALID_NAME)
    return read_scoped_file(root, path.name, MAX_IMPORT_BYTES)


def scoped_modified(root: Path, relative: str, *, regular: bool = False) -> int | None:
    """Observe a scoped entry without following a linked leaf or ancestor."""
    directory = None
    try:
        parts = Path(scoped_relative(relative)).parts
        directory = open_directory(canonical_root(root.expanduser().absolute()), parts[:-1])
        metadata = directory.stat(parts[-1])
        if getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            return None
        if not stat.S_ISREG(metadata.st_mode) and (regular or not stat.S_ISDIR(metadata.st_mode)):
            return None
        return metadata.st_mtime_ns
    except (OSError, ValueError):
        return None
    finally:
        if directory is not None:
            directory.close()


def scoped_files(root: Path, patterns: tuple[str, ...]) -> tuple[tuple[str, int], ...]:
    """Discover regular candidates; glob output itself carries no access authority."""
    directory = None
    try:
        root = canonical_root(root.expanduser().absolute())
        directory = open_directory(root, ())
        found: dict[str, int] = {}
        for pattern in patterns:
            for candidate in root.glob(pattern):
                relative = scoped_relative(str(candidate.relative_to(root)))
                modified = scoped_modified(root, relative, regular=True)
                if modified is not None:
                    found.setdefault(relative, modified)
        return tuple(found.items())
    except (OSError, ValueError):
        return ()
    finally:
        if directory is not None:
            directory.close()


def read_scoped_file(root: Path, relative: str, limit: int) -> bytes:
    """Read an explicitly named regular file without traversing symlinks."""
    path = Path(relative)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ValueError(INVALID_NAME)
    directory = None
    try:
        directory = open_directory(canonical_root(root), tuple(path.parts[:-1]))
        descriptor = directory.open(path.name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            metadata = os.fstat(handle.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
                raise ValueError(INVALID_NAME)
            data = handle.read(limit + 1)
            if len(data) > limit:
                raise ValueError(INVALID_NAME)
            return data
    finally:
        if directory is not None:
            directory.close()


def scoped_modified_ns(root: Path, relative: str, *, regular_only: bool = False) -> int | None:
    """Query an owned leaf without traversing linked ancestors."""
    path = Path(scoped_relative(relative))
    directory = None
    try:
        directory = open_directory(canonical_root(root), tuple(path.parts[:-1]))
        metadata = directory.stat(path.name)
        if stat.S_ISLNK(metadata.st_mode) or (
            os.name == WINDOWS_PLATFORM
            and getattr(metadata, "st_file_attributes") & FILE_ATTRIBUTE_REPARSE_POINT
        ):
            return None
        if not stat.S_ISREG(metadata.st_mode) and (
            regular_only or not stat.S_ISDIR(metadata.st_mode)
        ):
            return None
        return metadata.st_mtime_ns
    except OSError:
        return None
    finally:
        if directory is not None:
            directory.close()


def scoped_file_matches(root: Path, patterns: tuple[str, ...]) -> tuple[tuple[str, int], ...]:
    """Return relative regular-file matches and their observed modification times."""
    directory = canonical_root(root)
    found: list[tuple[str, int]] = []
    seen: set[str] = set()
    for pattern in patterns:
        for path in directory.glob(scoped_relative(pattern)):
            relative = scoped_relative(str(path.relative_to(directory)))
            if relative in seen:
                continue
            modified = scoped_modified_ns(directory, relative, regular_only=True)
            if modified is not None:
                seen.add(relative)
                found.append((relative, modified))
    return tuple(found)


def canonical_attachment_location(location: str) -> str:
    """Normalize an attachment reference inside the filesystem owner."""
    return str(Path(location).expanduser().resolve())


def is_managed_attachment(location: str) -> bool:
    return Path(location).is_absolute() and Path(location).is_relative_to(
        SERVICE_LITERATURE_FILES_DIR
    )


def delete_attachments(locations: tuple[str, ...]) -> None:
    """Unlink the owned regular files behind deleted attachment rows.

    每个文件只属于一条附件行, 所以这里不需要任何引用计数: 行删掉之后把路径交过来
    即可。托管目录之外的路径 (项目文件) 与已经不存在的文件都安静跳过 —— 前者归
    Content 域管, 后者说明清理已经发生过。派生的全文索引不靠这里的返回值收口,
    而是用附件行存下的 revision, 所以本函数不需要报告"真的删掉了哪些"。
    """

    root = SERVICE_LITERATURE_FILES_DIR.resolve()
    if not filesystem_path(root).is_dir():
        return
    directory = open_directory(root, ())
    try:
        for location in dict.fromkeys(locations):
            path = Path(location)
            if not path.is_absolute() or path.parent.resolve() != root:
                continue
            try:
                metadata = directory.stat(path.name)
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                directory.unlink(path.name)
            except FileNotFoundError:
                continue
    finally:
        directory.close()


class LiteratureFileBatch:
    """Own attachment writes alongside the literature catalogue transaction."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._temporary: TemporaryDirectory | None = None
        self._staged: list[tuple[Path, Path]] = []

    def __enter__(self) -> LiteratureFileBatch:
        root = filesystem_path(self._root)
        root.mkdir(parents=True, exist_ok=True)
        self._temporary = TemporaryDirectory(dir=root)
        return self

    def stage(self, name: str, payload: bytes) -> str:
        if self._temporary is None:
            raise RuntimeError(BATCH_NOT_OPEN)
        if not name or Path(name).name != name or name in {".", ".."}:
            raise ValueError(INVALID_NAME)
        destination = self._root / name
        staged = Path(self._temporary.name) / name
        staged.write_bytes(payload)
        self._staged.append((staged, destination))
        return str(destination)

    def commit(
        self,
        items: tuple[LiteratureItem, ...],
        saver: Callable[[tuple[LiteratureItem, ...]], tuple[LiteratureItem, ...]] | None = None,
    ) -> tuple[LiteratureItem, ...]:
        return self.commit_operation(lambda: (saver or LiteratureRepository().save_all)(items))

    def commit_operation(self, operation: Callable[[], T]) -> T:
        """Publish staged immutable files around one catalogue transaction."""

        created: list[Path] = []
        try:
            for staged, destination in self._staged:
                # 名字里带 uuid, 目标不可能已被别的副本占着: 直接搬, 不再用
                # "已存在就说明发布过了"这套内容寻址时代的推断。
                shutil.move(staged, filesystem_path(destination))
                created.append(destination)
            return operation()
        except BaseException:
            for destination in created:
                filesystem_path(destination).unlink(missing_ok=True)
            raise

    def __exit__(self, *_exc) -> None:
        if self._temporary is not None:
            self._temporary.cleanup()
            self._temporary = None
