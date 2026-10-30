"""项目路径空间: 项目根 + 虚拟挂载表 (content 域, 开发 1 拥有)。

proposal 47 §5.1 选定「外部根登记为项目内虚拟挂载点」这一表达, 目的是让
`FileAssetRef.path` 永远只有**一个**相对基 (项目根), 五个消费域的身份形状零变更。
代价是本域内部要维护挂载前缀映射 —— 就是这个类。

为什么把它单独拿出来而不塞进 `assets`:
越界校验、挂载解析、反向映射三件事必须给出**一致**的答案。分散在各处时,
`resolve()` 认为某路径在项目内、`rename()` 却把它当外部文件, 这种分歧不会
报错, 只会把用户的原始文件搬到错的地方。

安全语义与项目内一致: 解析后 `resolve()` 消符号链接再确认仍在授权根内,
所以挂载点里的 symlink 逃逸同样挡得住。
"""

from __future__ import annotations

from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterator

from service.content.domain.model import ContentError
from service.content.service.utils import open_directory
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.content import AssetKind, AssetOrigin, ProjectRef, RootKind
from service.platform.storage import (
    DirectoryHandle,
    DirectoryRole,
    filesystem_path,
    prepare_private_directory,
)

#: posix 路径分隔符。相对路径一律用它, 不跟随宿主平台。
SEPARATOR = "/"


@contextmanager
def project_database(root: Path) -> Iterator[Path | None]:
    """Discover existing private storage under a caller-qualified project root.

    Reuse Content's boundary resolver and strict directory traversal. Missing
    storage is not created. The caller must qualify the returned parent before
    opening SQLite, and finish all IO while this parent handle remains open.
    """
    with closing(open_directory(root, ())):
        _within(root, PROJECT_DB_RELATIVE, "path_outside_project")
        relative = PurePosixPath(PROJECT_DB_RELATIVE)
        try:
            parent = open_directory(root, tuple(relative.parent.parts))
        except FileNotFoundError:
            yield None
        else:
            with closing(parent):
                yield parent.child(relative.name)


def prepare_project_storage(root: Path) -> None:
    """Create private parents under an existing, exclusively qualified project.

    Does not create the database. The caller must rediscover and reacquire the
    complete directory set before opening project storage.
    """
    with closing(open_directory(root, ())):
        _within(root, PROJECT_DB_RELATIVE, "path_outside_project")
        relative = PurePosixPath(PROJECT_DB_RELATIVE)
        prepare_private_directory(root, tuple(relative.parent.parts), role=DirectoryRole.PROJECT)


@contextmanager
def project_version_storage(root: Path) -> Iterator[Path | None]:
    """Resolve existing resource storage through Content's project boundary.

    The caller retains the project qualification for the entire context. No
    private directory or CAS lock is created by this read-only lookup.
    """
    with closing(open_directory(root, ())):
        _within(root, PROJECT_VERSIONS_RELATIVE, "path_outside_project")
        try:
            directory = open_directory(root, PurePosixPath(PROJECT_VERSIONS_RELATIVE).parts)
        except FileNotFoundError:
            yield None
        else:
            with closing(directory):
                yield directory.path


@dataclass(frozen=True)
class Mount:
    """一处生效中的虚拟挂载。"""

    #: 相对项目根的挂载路径 (例如 `resources/外部资料`)。
    mount_path: str
    #: 外部真实绝对路径。
    source: Path
    #: 来源种类决定挂载点能否继续解析子路径。
    kind: AssetKind = AssetKind.DIR
    root_id: str = ""

    @property
    def name(self) -> str:
        return PurePosixPath(self.mount_path).name

    @property
    def parent(self) -> str:
        parent = str(PurePosixPath(self.mount_path).parent)
        return "" if parent == "." else parent


def normalize(relative: str) -> str:
    """归一相对路径: 去掉首尾分隔符与冗余段, 空串表示项目根。"""

    cleaned = relative.replace("\\", SEPARATOR).strip(SEPARATOR)
    if not cleaned or cleaned == ".":
        return ""
    parts = [part for part in cleaned.split(SEPARATOR) if part not in {"", "."}]
    return SEPARATOR.join(parts)


class ProjectSpace:
    """一个项目的路径空间。所有「相对路径 ↔ 绝对路径」的换算都经这里。"""

    def __init__(
        self,
        project: ProjectRef,
        mounts: tuple[Mount, ...] = (),
        *,
        owned_roots: dict[RootKind, str] | None = None,
        excluded_paths: tuple[str, ...] = (),
    ) -> None:
        self.project = project
        self.root = Path(project.root).expanduser().resolve()
        # 长前缀优先: 嵌套挂载时必须命中更具体的那一个。
        self.mounts = tuple(sorted(mounts, key=lambda item: len(item.mount_path), reverse=True))
        self.owned_roots = dict(owned_roots or {})
        self.excluded_paths = excluded_paths

    def excluded(self, relative: str) -> bool:
        return any(
            relative == path or relative.startswith(f"{path}{SEPARATOR}")
            for path in self.excluded_paths
        )

    # ---- 正向: 相对 → 绝对 ----

    def mount_for(self, relative: str) -> Mount | None:
        """命中的挂载点 (最长前缀优先)。

        前缀比较必须带分隔符: 否则 `resources/外部资料2` 会命中
        `resources/外部资料`, 于是一个无关目录被解析到别人的外部根里。
        """

        cleaned = normalize(relative)
        if not cleaned:
            return None
        for mount in self.mounts:
            if cleaned == mount.mount_path or cleaned.startswith(f"{mount.mount_path}{SEPARATOR}"):
                return mount
        return None

    def absolute(self, relative: str) -> Path:
        """相对路径 → 绝对路径, 越界即拒绝。

        命中挂载前缀时落到外部真实路径; 否则落在项目根内。两条分支都在
        `resolve()` 之后复核归属, 只做字符串前缀比较会被 symlink 绕过。
        """

        cleaned = normalize(relative)
        mount = self.mount_for(cleaned)
        if mount is None:
            return _within(self.root, cleaned, "path_outside_project")
        remainder = cleaned[len(mount.mount_path) :].strip(SEPARATOR)
        if remainder and mount.kind is AssetKind.FILE:
            raise ContentError("path_outside_authorized_root")
        return _within(mount.source, remainder, "path_outside_authorized_root")

    def open_directory(self, relative: str) -> DirectoryHandle:
        """Pin the authorized logical directory without resolving symlink ancestors."""
        cleaned = normalize(relative)
        mount = self.mount_for(cleaned)
        root = self.root if mount is None else mount.source
        remainder = cleaned if mount is None else cleaned[len(mount.mount_path) :].strip(SEPARATOR)
        if mount is not None and mount.kind is not AssetKind.DIR:
            raise ContentError("path_outside_authorized_root")
        return open_directory(root, tuple(PurePosixPath(remainder).parts))

    # ---- 反向: 绝对 → 相对 ----

    def open_parent(self, relative: str, *, create: bool = False) -> tuple[DirectoryHandle, str]:
        """Pin a file's authorized parent for private staging, not directory exposure."""
        self.absolute(relative)
        cleaned = normalize(relative)
        mount = self.mount_for(cleaned)
        if mount is not None and mount.kind is AssetKind.FILE:
            return open_directory(mount.source.parent, ()), mount.source.name
        root = self.root if mount is None else mount.source
        remainder = cleaned if mount is None else cleaned[len(mount.mount_path) :].strip(SEPARATOR)
        target = PurePosixPath(remainder)
        if not remainder or target.name in {".", ".."}:
            raise ContentError("not_a_file")
        return open_directory(root, tuple(target.parent.parts), create=create), target.name

    def relative(self, absolute: Path) -> str:
        """绝对路径 → 相对项目根的路径 (挂载内的落回挂载前缀)。"""

        target = absolute.expanduser().resolve()
        for mount in self.mounts:
            tail = _relative_to(target, mount.source)
            if tail == Path("."):
                return mount.mount_path
            if mount.kind is AssetKind.DIR and tail is not None:
                return f"{mount.mount_path}{SEPARATOR}{tail.as_posix()}"
        tail = _relative_to(target, self.root)
        if tail is not None:
            return "" if tail == Path(".") else tail.as_posix()
        raise ContentError("path_outside_project")

    # ---- 归属判定 ----

    def origin(self, relative: str) -> AssetOrigin:
        """这份资产是项目内副本还是关联进来的项目外文件。"""

        return AssetOrigin.LINK if self.mount_for(normalize(relative)) else AssetOrigin.LOCAL

    def is_mount_root(self, relative: str) -> bool:
        """是否正好是某个挂载点本身。

        挂载点本身不可改名/移动/删除: 那会动到用户的外部目录, 而「取消关联」
        的正确入口是撤销授权 (可留痕、可恢复)。
        """

        cleaned = normalize(relative)
        return any(mount.mount_path == cleaned for mount in self.mounts)

    def mounts_in(self, relative_dir: str) -> tuple[Mount, ...]:
        """直接挂在给定目录下的挂载点 (供树投影合并)。"""

        parent = normalize(relative_dir)
        return tuple(mount for mount in self.mounts if mount.parent == parent)


def _relative_to(target: Path, base: Path) -> Path | None:
    """Compare resolved identities in the same platform path namespace.

    Windows resolution may return ordinary or extended path spelling. Normalize
    spelling after resolution without replacing the returned path. Containment
    is still checked against the resolved root, including symlink destinations.
    """
    try:
        return filesystem_path(target).relative_to(filesystem_path(base))
    except ValueError:
        return None


def _within(base: Path, relative: str, error: str) -> Path:
    """把相对路径解析到 base 内, 越界即拒绝。"""

    resolved_base = base.expanduser().resolve()
    if not relative:
        return resolved_base
    target = (resolved_base / relative).resolve()
    if _relative_to(target, resolved_base) is None:
        raise ContentError(error)
    return target


__all__ = [
    "SEPARATOR",
    "Mount",
    "ProjectSpace",
    "normalize",
    "project_database",
    "prepare_project_storage",
]
