"""项目内文件操作原语 (content 域, 开发 1 拥有)。

PRD「本地文件同步」要求: 用户在书深中管理的是真实本地资料, 重命名、
移动、复制、删除后本地文件同步发生相同变化。因此本模块直接操作磁盘,
不维护第二份索引。

安全边界: 所有路径都经 `ProjectSpace` 换算 (proposal 47 §5.1) —— 它同时负责
越界校验与虚拟挂载解析。因此关联进来的文件在同一关联根内改名/移动会作用在
原始物理文件上；物理删除则统一拒绝，用户只能撤销关联并保留原文件。

删除走系统废纸篓语义 (由 Electron 主进程执行), 后端只做 `trash` 前的校验,
避免静默永久删除用户资料。
"""

from __future__ import annotations

import errno
import hashlib
import os
import shutil
import stat
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from service.content.domain.model import PREPARED_CONFLICT, PREPARED_UNAVAILABLE, ContentError
from service.content.service.enumeration import GITIGNORE_FILENAME
from service.content.service.native import (
    CREATION_MARKER_BYTES,
    copy_descriptor_exclusive,
    creation_marker,
    publish_descriptor,
    rename_exclusive,
    set_creation_marker,
    sync_published_descriptor,
)
from service.content.service.space import ProjectSpace
from service.content.service.utils import filesystem_error, name_length_error
from service.platform.content import (
    AssetKind,
    AssetOrigin,
    FileAssetRef,
    ImportCollisionPolicy,
    ImportMode,
    PreparedContent,
)
from service.platform.storage import NOFOLLOW, NONBLOCK, DirectoryHandle

#: 新建 Markdown 资料的默认扩展名 (PRD「新建文档.md」)。
MARKDOWN_SUFFIX = ".md"

#: 关联目录当前不可访问（授权失效、原目录被移动或卸载）。
AUTHORIZED_ROOT_UNAVAILABLE = "authorized_root_unavailable"

#: 目标目录存在但当前进程没有写权限。
PARENT_NOT_WRITABLE = "parent_not_writable"

#: 同名冲突时的序号上限, 超过即报错而不是无限试探。
MAX_NAME_ATTEMPTS = 999

#: 非法文件名字符 (路径分隔符与空字节), 阻断目录穿越与坏名字。
FORBIDDEN_NAME_CHARS = frozenset({"/", "\\", "\x00"})

#: 自定义导入名称必须与来源逐项对应，且只适用于 COPY。
INVALID_IMPORT_TARGET_NAMES = "invalid_import_target_names"
DIRECTORY_CONFLICT = "directory_conflict"
DIRECTORY_UNAVAILABLE = "directory_unavailable"
CREATE_TEMP_PREFIX = ".create-"
HEX_CHARACTERS = frozenset("0123456789abcdef")
CONTENT_SHA256_HEX_LENGTH = hashlib.sha256().digest_size * 2
CREATE_TEMP_MODE = 0o600
WRITE_FAILED = "write_failed"
TOO_MANY_DUPLICATES = "too_many_duplicates"
PREPARED_CHUNK_BYTES = 1024 * 1024
NAME_EXISTS = "name_exists"
RENAME_FAILED = "rename_failed"
FILE_EXTENSION_CHANGE_FORBIDDEN = "file_extension_change_forbidden"
MOVE_SCOPE_MISMATCH = "move_scope_mismatch"
CANNOT_TRASH_LINKED = "cannot_trash_linked"


@dataclass(frozen=True)
class CopyMember:
    source: Path
    target: Path


@dataclass(frozen=True)
class CopyPlan:
    root: Path
    directories: tuple[CopyMember, ...]
    files: tuple[CopyMember, ...]


@dataclass(frozen=True)
class ImportPlanResult:
    source_index: int
    plan: CopyPlan | None
    error: str


def validate_name(name: str) -> str:
    """校验用户输入的文件/目录名。"""

    cleaned = name.strip()
    if not cleaned or cleaned in {".", ".."}:
        raise ContentError("invalid_name")
    if any(char in FORBIDDEN_NAME_CHARS for char in cleaned):
        raise ContentError("invalid_name")
    return cleaned


def _probe_free(candidate: Path, reserved: frozenset[Path]) -> bool:
    """Whether a candidate name is unclaimed, surfacing length failures.

    `Path.exists()` swallows ENOENT/ENOTDIR but re-raises ENAMETOOLONG (and the
    Windows 206 equivalent), so an over-limit name would otherwise escape as a
    raw OSError → 500 from callers that do not wrap the probe. Classifying it
    here makes every `unique_path` consumer — create, rename, move, copy, import
    — report the actionable `name_too_long` instead. Other OSErrors propagate
    unchanged so each caller keeps its own fallback.
    """

    try:
        exists = candidate.exists()
    except OSError as error:
        length_error = name_length_error(error, candidate)
        if length_error is not None:
            raise length_error from error
        raise
    return not exists and candidate not in reserved


def unique_path(parent: Path, name: str, reserved: frozenset[Path] = frozenset()) -> Path:
    """在 parent 下取一个不冲突的路径。

    与原型一致: 同名不覆盖, 自动追加 ` (2)`、` (3)`。保留原扩展名,
    序号插在扩展名之前。
    """

    candidate = parent / name
    if _probe_free(candidate, reserved):
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    for index in range(2, MAX_NAME_ATTEMPTS + 1):
        probe = parent / f"{stem} ({index}){suffix}"
        if _probe_free(probe, reserved):
            return probe
    raise ContentError("too_many_duplicates")


def _import_reservations(space: ProjectSpace) -> set[Path]:
    return {space.root / mount.mount_path for mount in space.mounts}


def import_target_paths(
    space: ProjectSpace,
    target_dir: str,
    names: tuple[str, ...],
) -> tuple[Path, ...]:
    """Allocate collision-free import targets across local entries and virtual mounts."""

    destination_dir = _parent_directory(space, target_dir)
    reserved = _import_reservations(space)
    targets: list[Path] = []
    for name in names:
        target = unique_path(destination_dir, validate_name(name), frozenset(reserved))
        reserved.add(target)
        targets.append(target)
    return tuple(targets)


def node_for(space: ProjectSpace, target: Path) -> FileAssetRef:
    """把一个磁盘条目描述成跨域可传的稳定引用。"""

    relative = space.relative(target)
    return FileAssetRef(
        project_id=space.project.id,
        path=relative,
        name=target.name,
        kind=AssetKind.DIR if target.is_dir() else AssetKind.FILE,
        origin=space.origin(relative),
    )


def _mutable(space: ProjectSpace, relative: str) -> Path:
    """取一个允许被改名/移动/删除的目标。

    项目根与挂载点本身都不可动: 前者会把整个项目搬走, 后者会动到用户的外部
    目录 —— 取消关联的正确入口是撤销授权 (留痕、可恢复), 不是改名。
    """

    target = space.absolute(relative)
    if target == space.root:
        raise ContentError("cannot_modify_root")
    if space.is_mount_root(relative):
        raise ContentError("cannot_modify_mount")
    if not target.exists():
        raise ContentError("node_not_found")
    return target


def _parent_directory(space: ProjectSpace, relative: str) -> Path:
    """重新解析并校验本次写入目标，不替调用方静默改选目录。"""

    target = space.absolute(relative)
    if not target.is_dir():
        if space.mount_for(relative) is not None:
            raise ContentError(AUTHORIZED_ROOT_UNAVAILABLE)
        raise ContentError("parent_not_found")
    if not os.access(target, os.W_OK):
        raise ContentError(PARENT_NOT_WRITABLE)
    return target


def create_document(space: ProjectSpace, parent: str, name: str) -> FileAssetRef:
    """新建 Markdown 资料 (PRD「新建文档.md」)。"""

    return _create_text_document(space, parent, name, None)


def document_target(space: ProjectSpace, parent: str, name: str) -> Path:
    """Resolve a collision-free Markdown target without writing it."""

    cleaned = validate_name(name)
    if not cleaned.endswith(MARKDOWN_SUFFIX):
        cleaned = f"{cleaned}{MARKDOWN_SUFFIX}"
    try:
        return unique_path(_parent_directory(space, parent), cleaned)
    except OSError as error:
        raise filesystem_error(error, WRITE_FAILED) from error


def file_target(space: ProjectSpace, parent: str, name: str) -> Path:
    """Resolve a collision-free generic file target without changing its suffix."""

    directory = _parent_directory(space, parent)
    reserved = frozenset(space.root / mount.mount_path for mount in space.mounts)
    return unique_path(directory, validate_name(name), reserved)


def create_text_document(
    space: ProjectSpace,
    parent: str,
    name: str,
    content: str,
) -> FileAssetRef:
    """创建带初始内容的 Markdown 资料，同名时避让且失败不留空文件。"""

    return _create_text_document(space, parent, name, content)


def _create_text_document(
    space: ProjectSpace,
    parent: str,
    name: str,
    content: str | None,
) -> FileAssetRef:
    """统一创建 Markdown；没有初始内容时创建空正文。"""

    cleaned = validate_name(name)
    if not cleaned.endswith(MARKDOWN_SUFFIX):
        cleaned = f"{cleaned}{MARKDOWN_SUFFIX}"
    initial = "" if content is None else content
    return create_bytes_document(space, parent, cleaned, initial.encode("utf-8"))


def create_bytes_document(
    space: ProjectSpace, parent: str, name: str, content: bytes
) -> FileAssetRef:
    """Create exact bytes under a conflict-avoiding name, never overwrite."""
    return _create_bytes_document(space, parent, name, lambda _filename: content)


def _create_bytes_document(
    space: ProjectSpace, parent: str, name: str, content: Callable[[str], bytes]
) -> FileAssetRef:

    cleaned = validate_name(name)
    parent_dir = _parent_directory(space, parent)
    target = parent_dir / cleaned
    temporary = f"{CREATE_TEMP_PREFIX}{uuid.uuid4().hex}"
    descriptor = None
    output = None
    staged = False
    try:
        descriptor = space.open_directory(parent)
        output = _open_stage(descriptor, temporary)
        staged = True
        # 从仍打开的描述符发布, 不再按可替换的暂存名重新取源。
        for index in range(1, MAX_NAME_ATTEMPTS + 1):
            filename = (
                cleaned if index == 1 else f"{Path(cleaned).stem} ({index}){Path(cleaned).suffix}"
            )
            target = parent_dir / filename
            os.lseek(output, 0, os.SEEK_SET)
            os.ftruncate(output, 0)
            _write_stage(output, content(filename))
            try:
                publish_descriptor(output, descriptor, filename)
            except FileExistsError:
                continue
            sync_published_descriptor(output, descriptor, filename)
            descriptor.sync()
            return node_for(space, parent_dir / filename)
        raise ContentError(TOO_MANY_DUPLICATES)
    except OSError as exc:
        raise filesystem_error(exc, WRITE_FAILED, target) from exc
    finally:
        if descriptor is not None:
            try:
                if staged and output is not None:
                    _unlink_stage(descriptor, temporary, os.fstat(output))
            except OSError as exc:
                raise ContentError(WRITE_FAILED) from exc
            finally:
                if output is not None:
                    os.close(output)
                descriptor.close()


def _open_stage(directory: DirectoryHandle, name: str) -> int:
    return directory.open(
        name,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW,
        CREATE_TEMP_MODE,
    )


def _write_stage(descriptor: int, content: bytes) -> os.stat_result:
    # Keep the caller's descriptor pinned through publication or receipt creation.
    with os.fdopen(os.dup(descriptor), "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
        return os.fstat(stream.fileno())


def _unlink_stage(directory: DirectoryHandle, name: str, identity: os.stat_result) -> None:
    """Never knowingly remove a replacement left at our random staging name."""
    try:
        current = directory.stat(name)
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise ContentError(PREPARED_CONFLICT)
        directory.unlink(name)
    except FileNotFoundError:
        pass


def prepare_bytes_document(
    space: ProjectSpace,
    parent: str,
    name: str,
    content: bytes,
    reserved_paths: tuple[str, ...],
) -> PreparedContent:
    """Stage complete bytes; caller persists this receipt before publishing.

    The caller serializes its reservation table, supplying its already reserved
    paths. Concurrent external files are still guarded by exclusive publication.
    """
    cleaned = validate_name(name)
    parent_dir = space.absolute(parent)
    temporary = f"{CREATE_TEMP_PREFIX}{uuid.uuid4().hex}"
    marker = uuid.uuid4().hex
    descriptor = None
    output = None
    staged = False
    try:
        descriptor = space.open_directory(parent)
        for index in range(1, MAX_NAME_ATTEMPTS + 1):
            filename = (
                cleaned if index == 1 else f"{Path(cleaned).stem} ({index}){Path(cleaned).suffix}"
            )
            relative = (Path(space.relative(parent_dir)) / filename).as_posix()
            if relative in reserved_paths:
                continue
            try:
                descriptor.stat(filename)
            except FileNotFoundError:
                break
        else:
            raise ContentError(TOO_MANY_DUPLICATES)
        output = _open_stage(descriptor, temporary)
        staged = True
        set_creation_marker(output, marker)
        identity = _write_stage(output, content)
        descriptor.sync()
        return PreparedContent(
            space.project.id,
            relative,
            space.relative(parent_dir / temporary),
            identity.st_dev,
            identity.st_ino,
            len(content),
            hashlib.sha256(content).hexdigest(),
            marker,
        )
    except OSError as error:
        if staged and descriptor is not None and output is not None:
            _unlink_stage(descriptor, temporary, os.fstat(output))
        raise ContentError(WRITE_FAILED) from error
    finally:
        if output is not None:
            os.close(output)
        if descriptor is not None:
            descriptor.close()


def validate_prepared(prepared: PreparedContent) -> None:
    """Validate persisted receipt structure without resolving paths or touching files."""
    if any(
        not isinstance(value, str) or not value or "\x00" in value
        for value in (
            prepared.project_id,
            prepared.path,
            prepared.staging_path,
            prepared.marker,
            prepared.sha256,
        )
    ) or any(
        type(value) is not int or value < 0
        for value in (prepared.device, prepared.inode, prepared.size)
    ):
        raise ContentError(PREPARED_CONFLICT)
    if (
        len(prepared.marker) != CREATION_MARKER_BYTES
        or not set(prepared.marker) <= HEX_CHARACTERS
        or len(prepared.sha256) != CONTENT_SHA256_HEX_LENGTH
        or not set(prepared.sha256) <= HEX_CHARACTERS
    ):
        raise ContentError(PREPARED_CONFLICT)
    target = Path(prepared.path)
    staging = Path(prepared.staging_path)
    if any(path.is_absolute() or ".." in path.parts for path in (target, staging)):
        raise ContentError(PREPARED_CONFLICT)
    if target.parent != staging.parent or not staging.name.startswith(CREATE_TEMP_PREFIX):
        raise ContentError(PREPARED_CONFLICT)
    validate_name(target.name)
    validate_name(staging.name)


def _prepared_parent(space: ProjectSpace, prepared: PreparedContent) -> Path:
    validate_prepared(prepared)
    if prepared.project_id != space.project.id:
        raise ContentError(PREPARED_CONFLICT)
    return space.absolute(Path(prepared.path).parent.as_posix())


def _same_prepared(identity: os.stat_result, prepared: PreparedContent) -> bool:
    return stat.S_ISREG(identity.st_mode) and (identity.st_dev, identity.st_ino) == (
        prepared.device,
        prepared.inode,
    )


def _verify_prepared(stream, prepared: PreparedContent, *, staging: bool) -> None:
    before = os.fstat(stream.fileno())
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_size != prepared.size
        or (staging and not _same_prepared(before, prepared))
        or creation_marker(stream.fileno()) != prepared.marker
    ):
        raise ContentError(PREPARED_CONFLICT)
    digest = hashlib.sha256()
    remaining = prepared.size
    while remaining:
        chunk = stream.read(min(remaining, PREPARED_CHUNK_BYTES))
        if not chunk:
            raise ContentError(PREPARED_CONFLICT)
        digest.update(chunk)
        remaining -= len(chunk)
    after = os.fstat(stream.fileno())
    if (
        digest.hexdigest() != prepared.sha256
        or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        or stream.read(1)
    ):
        raise ContentError(PREPARED_CONFLICT)


def _published_asset(
    space: ProjectSpace,
    prepared: PreparedContent,
    directory: DirectoryHandle,
    parent: Path,
) -> FileAssetRef:
    target_name = Path(prepared.path).name
    target = directory.open(target_name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(target, "rb") as stream:
        _verify_prepared(stream, prepared, staging=False)
    return node_for(space, parent / target_name)


def _remove_owned_prepared_target(
    directory: DirectoryHandle, prepared: PreparedContent, target_name: str
) -> None:
    target = directory.open(target_name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(target, "rb") as stream:
        if creation_marker(stream.fileno()) != prepared.marker:
            raise ContentError(PREPARED_CONFLICT)
        identity = os.fstat(stream.fileno())
    current = directory.stat(target_name)
    if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
        raise ContentError(PREPARED_CONFLICT)
    directory.unlink(target_name)


def publish_prepared(space: ProjectSpace, prepared: PreparedContent) -> FileAssetRef:
    """Publish from the verified fd; replay using creation marker and exact bytes."""
    parent = _prepared_parent(space, prepared)
    descriptor = None
    invalid_target = None
    try:
        descriptor = space.open_directory(Path(prepared.path).parent.as_posix())
        try:
            return _published_asset(space, prepared, descriptor, parent)
        except FileNotFoundError:
            pass
        except ContentError as error:
            invalid_target = error
        stage_name = Path(prepared.staging_path).name
        target_name = Path(prepared.path).name
        try:
            source = descriptor.open(stage_name, os.O_RDWR | NOFOLLOW | NONBLOCK)
        except FileNotFoundError:
            if invalid_target is not None:
                raise invalid_target
            raise
        with os.fdopen(source, "rb") as stream:
            _verify_prepared(stream, prepared, staging=True)
            if invalid_target is not None:
                _remove_owned_prepared_target(descriptor, prepared, target_name)
            try:
                copy_descriptor_exclusive(
                    stream.fileno(),
                    descriptor,
                    target_name,
                    CREATE_TEMP_MODE,
                    marker=prepared.marker,
                )
            except FileExistsError:
                pass  # Existing targets still need operation identity AND byte verification.
        return _published_asset(space, prepared, descriptor, parent)
    except OSError as error:
        raise ContentError(PREPARED_UNAVAILABLE) from error
    finally:
        if descriptor is not None:
            descriptor.close()


def prepared_asset(space: ProjectSpace, prepared: PreparedContent) -> FileAssetRef:
    """Look up a completed creation without recreating a deleted/replaced file."""
    _prepared_parent(space, prepared)
    descriptor = None
    try:
        descriptor = space.open_directory(Path(prepared.path).parent.as_posix())
        target = descriptor.open(Path(prepared.path).name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        with os.fdopen(target, "rb") as stream:
            if (
                not stat.S_ISREG(os.fstat(stream.fileno()).st_mode)
                or creation_marker(stream.fileno()) != prepared.marker
            ):
                raise ContentError(PREPARED_CONFLICT)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ContentError(PREPARED_CONFLICT) from error
        raise ContentError(PREPARED_UNAVAILABLE) from error
    finally:
        if descriptor is not None:
            descriptor.close()
    return FileAssetRef(
        project_id=space.project.id,
        path=prepared.path,
        name=Path(prepared.path).name,
        kind=AssetKind.FILE,
        origin=space.origin(prepared.path),
    )


def release_prepared(space: ProjectSpace, prepared: PreparedContent) -> None:
    """Remove only our staging link after its owner has committed the result."""
    parent = _prepared_parent(space, prepared)
    descriptor = None
    try:
        descriptor = space.open_directory(Path(prepared.path).parent.as_posix())
        name = Path(prepared.staging_path).name
        try:
            if not _same_prepared(descriptor.stat(name), prepared):
                raise ContentError(PREPARED_CONFLICT)
            descriptor.unlink(name)
        except FileNotFoundError:
            pass  # A completed operation can safely repeat cleanup.
    except OSError as error:
        raise ContentError(PREPARED_UNAVAILABLE) from error
    finally:
        if descriptor is not None:
            descriptor.close()


def create_folder(space: ProjectSpace, parent: str, name: str) -> FileAssetRef:
    """新建文件夹 (PRD「新建文件夹」)。"""

    cleaned = validate_name(name)
    parent_dir = _parent_directory(space, parent)
    target = parent_dir / cleaned
    try:
        target = unique_path(parent_dir, cleaned)
        target.mkdir(parents=False)
    except PermissionError as exc:
        raise ContentError(PARENT_NOT_WRITABLE) from exc
    except OSError as exc:
        raise filesystem_error(exc, WRITE_FAILED, target) from exc
    return node_for(space, target)


def ensure_folder(space: ProjectSpace, parent: str, name: str) -> FileAssetRef:
    """Create an exact directory, or reuse that directory without name avoidance."""
    cleaned = validate_name(name)
    parent_dir = space.absolute(parent)
    descriptor = None
    try:
        descriptor = space.open_directory(parent)
        try:
            descriptor.mkdir(cleaned)
        except FileExistsError:
            if not stat.S_ISDIR(descriptor.stat(cleaned).st_mode):
                raise ContentError(DIRECTORY_CONFLICT)
        descriptor.sync()
    except OSError as error:
        raise ContentError(DIRECTORY_UNAVAILABLE) from error
    finally:
        if descriptor is not None:
            descriptor.close()
    return node_for(space, parent_dir / cleaned)


def rename_target(space: ProjectSpace, path: str, name: str) -> Path:
    """Choose the exact collision-free rename target after enforcing suffix identity."""

    cleaned = validate_name(name)
    source = _mutable(space, path)
    if source.is_file() and source.suffix != Path(cleaned).suffix:
        raise ContentError(FILE_EXTENSION_CHANGE_FORBIDDEN)
    requested = source.parent / cleaned
    if requested == source:
        return source
    return unique_path(source.parent, cleaned)


def rename_node(
    space: ProjectSpace,
    path: str,
    name: str,
    *,
    destination: Path | None = None,
) -> FileAssetRef:
    """重命名 (PRD「重命名」: 书深与本地名称同步更新)。

    关联进来的文件同样在这里改 —— 作用于原始物理路径, 这正是「关联」与
    「复制」两种导入模式的实质区别。
    """

    target = _mutable(space, path)
    destination = destination or rename_target(space, path, name)
    if destination == target:
        return node_for(space, target)
    directory = None
    try:
        directory = space.open_directory(space.relative(target.parent))
        rename_exclusive(directory, target.name, directory, destination.name)
        directory.sync()
    except FileExistsError as exc:
        raise ContentError(NAME_EXISTS) from exc
    except OSError as exc:
        raise ContentError(RENAME_FAILED) from exc
    finally:
        if directory is not None:
            directory.close()
    return node_for(space, destination)


def _move_source_and_directory(
    space: ProjectSpace,
    path: str,
    target_dir: str,
) -> tuple[Path, Path]:
    """Resolve and validate one move without choosing or mutating its destination name."""

    source = _mutable(space, path)
    destination_dir = _parent_directory(space, target_dir)
    source_mount = space.mount_for(path)
    destination_mount = space.mount_for(target_dir)
    source_scope = source_mount.root_id if source_mount is not None else None
    destination_scope = destination_mount.root_id if destination_mount is not None else None
    if source_scope != destination_scope:
        raise ContentError(MOVE_SCOPE_MISMATCH)
    # 目录不能移进自己的子树, 否则会把自己搬没。
    if source.is_dir() and (destination_dir == source or source in destination_dir.parents):
        raise ContentError("move_into_self")
    return source, destination_dir


def move_target(space: ProjectSpace, path: str, target_dir: str) -> Path:
    """Choose the exact collision-free target after enforcing the move scope."""

    source, destination_dir = _move_source_and_directory(space, path, target_dir)
    if destination_dir == source.parent:
        return source
    return unique_path(destination_dir, source.name)


def move_node(
    space: ProjectSpace,
    path: str,
    target_dir: str,
    *,
    destination: Path | None = None,
) -> FileAssetRef:
    """移动资料 (PRD「移动资料」: 本地目录同步变化)。"""

    source, destination_dir = _move_source_and_directory(space, path, target_dir)
    if destination_dir == source.parent:
        return node_for(space, source)
    destination = destination or unique_path(destination_dir, source.name)
    source_directory = None
    target_directory = None
    try:
        source_directory = space.open_directory(space.relative(source.parent))
        target_directory = space.open_directory(target_dir)
        rename_exclusive(source_directory, source.name, target_directory, destination.name)
        source_directory.sync()
        if target_directory != source_directory:
            target_directory.sync()
    except FileExistsError as exc:
        raise ContentError(NAME_EXISTS) from exc
    except OSError as exc:
        raise ContentError("move_failed") from exc
    finally:
        if source_directory is not None:
            source_directory.close()
        if target_directory is not None and target_directory != source_directory:
            target_directory.close()
    return node_for(space, destination)


def copy_plan(space: ProjectSpace, path: str, target_dir: str | None = None) -> CopyPlan:
    """Plan a file or directory copy without mutating the filesystem."""

    source = space.absolute(path)
    if source == space.root:
        raise ContentError("cannot_modify_root")
    if not source.exists():
        raise ContentError("node_not_found")
    destination_dir = source.parent if target_dir is None else space.absolute(target_dir)
    if not destination_dir.is_dir():
        raise ContentError("target_not_found")
    if source.is_dir() and (destination_dir == source or source in destination_dir.parents):
        raise ContentError("copy_into_self")
    return _copy_plan(source, unique_path(destination_dir, source.name))


def import_plans(
    space: ProjectSpace,
    sources: tuple[str, ...],
    target_dir: str,
    target_names: tuple[str, ...] | None = None,
    collision_policy: ImportCollisionPolicy = ImportCollisionPolicy.RENAME,
    discovered: Callable[[int], None] | None = None,
) -> tuple[CopyPlan, ...]:
    """Plan COPY imports with stable collision avoidance and optional target names."""

    results = import_plan_results(
        space,
        sources,
        target_dir,
        target_names,
        collision_policy=collision_policy,
        discovered=discovered,
    )
    for result in results:
        if result.plan is None:
            raise ContentError(result.error)
    return tuple(result.plan for result in results if result.plan is not None)


def import_plan_results(
    space: ProjectSpace,
    sources: tuple[str, ...],
    target_dir: str,
    target_names: tuple[str, ...] | None = None,
    collision_policy: ImportCollisionPolicy = ImportCollisionPolicy.RENAME,
    discovered: Callable[[int], None] | None = None,
) -> tuple[ImportPlanResult, ...]:
    """Plan each selected source independently while reserving successful targets."""

    if target_names is not None and len(target_names) != len(sources):
        raise ContentError(INVALID_IMPORT_TARGET_NAMES)
    destination_dir = _parent_directory(space, target_dir)
    results: list[ImportPlanResult] = []
    reserved = _import_reservations(space)
    for index, raw in enumerate(sources):
        try:
            source = Path(raw).expanduser()
            if not source.exists():
                raise ContentError("source_not_found")
            target_name = (
                source.name if target_names is None else validate_name(target_names[index])
            )
            requested = destination_dir / target_name
            if collision_policy is ImportCollisionPolicy.EXACT:
                if requested.exists() or requested in reserved:
                    raise ContentError(NAME_EXISTS)
                destination = requested
            else:
                destination = unique_path(destination_dir, target_name, frozenset(reserved))
            plan = _copy_plan(source, destination, discovered)
        except ContentError as error:
            results.append(ImportPlanResult(index, None, error.code))
            continue
        reserved.add(destination)
        results.append(ImportPlanResult(index, plan, ""))
    return tuple(results)


def linked_sources(space: ProjectSpace, sources: tuple[str, ...]) -> tuple[FileAssetRef, ...]:
    """Validate LINK imports without copying their original filesystem entries."""

    linked: list[FileAssetRef] = []
    for raw in sources:
        source = Path(raw).expanduser()
        if not source.exists():
            raise ContentError("source_not_found")
        linked.append(
            FileAssetRef(
                project_id=space.project.id,
                path=source.as_posix(),
                name=source.name,
                kind=AssetKind.DIR if source.is_dir() else AssetKind.FILE,
                origin=AssetOrigin.LINK,
            )
        )
    return tuple(linked)


def _copy_plan(
    source: Path,
    destination: Path,
    discovered: Callable[[int], None] | None = None,
) -> CopyPlan:
    if source.is_file():
        if discovered is not None:
            discovered(1)
        return CopyPlan(destination, (), (CopyMember(source, destination),))
    if not source.is_dir():
        raise ContentError("source_not_found")
    directories: list[CopyMember] = []
    files: list[CopyMember] = []
    try:
        _collect_copy_members(source, destination, frozenset(), directories, files, discovered)
    except OSError as exc:
        raise ContentError("copy_failed") from exc
    directories.sort(key=lambda item: (len(item.target.parts), item.target.as_posix()))
    files.sort(
        key=lambda item: (
            len(item.target.parts),
            item.target.name != GITIGNORE_FILENAME,
            item.target.as_posix(),
        )
    )
    return CopyPlan(destination, tuple(directories), tuple(files))


def _collect_copy_members(
    source: Path,
    target: Path,
    ancestors: frozenset[tuple[int, int]],
    directories: list[CopyMember],
    files: list[CopyMember],
    discovered: Callable[[int], None] | None = None,
) -> None:
    source_stat = source.stat()
    identity = (source_stat.st_dev, source_stat.st_ino)
    if identity in ancestors:
        raise ContentError("copy_failed")
    directories.append(CopyMember(source, target))
    if discovered is not None:
        discovered(1)
    child_ancestors = ancestors | {identity}
    for child in sorted(source.iterdir(), key=lambda item: item.name):
        child_target = target / child.name
        if child.is_dir():
            _collect_copy_members(
                child, child_target, child_ancestors, directories, files, discovered
            )
        elif child.is_file():
            files.append(CopyMember(child, child_target))
            if discovered is not None:
                discovered(1)
        else:
            raise ContentError("copy_failed")


def import_sources(
    space: ProjectSpace,
    sources: tuple[str, ...],
    target_dir: str,
    mode: ImportMode,
    target_names: tuple[str, ...] | None = None,
) -> tuple[FileAssetRef, ...]:
    """导入本地文件/文件夹 (PRD「导入本地文件」「导入本地文件夹」)。

    COPY: 复制进项目空间, Agent 改副本, 用户原文件不受影响。
    LINK: 不搬移原文件 —— 关联关系由 `authorize_root` 登记成虚拟挂载点,
    本函数只校验源可读并回报节点; 来源交由调用方去授权, 避免这里
    悄悄产生一个没有授权记录、也无法撤销的"半关联"。
    """

    if target_names is not None and (
        mode is not ImportMode.COPY or len(target_names) != len(sources)
    ):
        raise ContentError(INVALID_IMPORT_TARGET_NAMES)

    destination_dir = space.absolute(target_dir)
    if not destination_dir.is_dir():
        raise ContentError("target_not_found")

    imported: list[FileAssetRef] = []
    for index, raw in enumerate(sources):
        source = Path(raw).expanduser()
        if not source.exists():
            raise ContentError("source_not_found")
        if mode is ImportMode.LINK:
            imported.append(
                FileAssetRef(
                    project_id=space.project.id,
                    path=source.as_posix(),
                    name=source.name,
                    kind=AssetKind.DIR if source.is_dir() else AssetKind.FILE,
                    origin=AssetOrigin.LINK,
                )
            )
            continue
        target_name = source.name if target_names is None else validate_name(target_names[index])
        destination = unique_path(destination_dir, target_name)
        try:
            if source.is_dir():
                # 保留原有目录结构 (PRD「导入本地文件夹」)。
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
        except OSError as exc:
            raise ContentError("import_failed") from exc
        imported.append(node_for(space, destination))
    return tuple(imported)


def resolve_for_delete(space: ProjectSpace, path: str) -> Path:
    """删除前的校验, 返回待删的绝对路径。

    真正的删除由 Electron 主进程走系统废纸篓 (`shell.trashItem`),
    后端不做永久删除 —— 用户资料不可静默不可恢复地消失。
    """

    if space.mount_for(path) is not None:
        raise ContentError(CANNOT_TRASH_LINKED)
    return _mutable(space, path)


__all__ = [
    "AUTHORIZED_ROOT_UNAVAILABLE",
    "CANNOT_TRASH_LINKED",
    "CopyMember",
    "CopyPlan",
    "ImportPlanResult",
    "FILE_EXTENSION_CHANGE_FORBIDDEN",
    "MARKDOWN_SUFFIX",
    "MOVE_SCOPE_MISMATCH",
    "PARENT_NOT_WRITABLE",
    "ContentError",
    "copy_plan",
    "create_document",
    "create_folder",
    "create_text_document",
    "document_target",
    "file_target",
    "import_target_paths",
    "import_plans",
    "import_plan_results",
    "import_sources",
    "move_node",
    "move_target",
    "node_for",
    "rename_node",
    "rename_target",
    "resolve_for_delete",
    "unique_path",
    "validate_name",
]
