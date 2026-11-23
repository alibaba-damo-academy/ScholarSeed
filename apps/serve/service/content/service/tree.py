"""资料树扫描 (content 域, 开发 1 拥有)。

读的是项目目录下真实的本地文件, 不维护第二份索引 —— PRD 要求
「用户在书深中管理的是真实本地资料」, 所以树就是磁盘的投影。

产出 `AssetPage` / `AssetTree`(platform 契约) 而非域内私有形状: 资料库与文献库
都要消费它, 用共享契约才能让两个域互不依赖。

两条 proposal 47 的语义在这里落地:

- 节点 `path` 一律**相对项目根**, 即使扫描起点是 `resources/`。扫描起点与相对基
  不是一回事: 若按扫描起点算相对路径, MANAGED 项目的树会给出 `笔记.md`,
  而 `resolve()` 按项目根解析成 `<项目>/笔记.md` —— 一个不存在的位置。
- 挂载点在其父目录处合并进来 (§5.1)。挂载点位置若同时存在真实同名目录,
  以**登记的挂载**为准并把该节点标 `conflict=True`, 让 UI 明示而不是二选一。

两个上限都是**取数分页, 不是可见性上限**, 所以都必须把「还有多少」交出去:

- 纵向 (`DEFAULT_MAX_DEPTH`): 更深的层级由消费方展开时按 path 续扫;
- 横向 (`PAGE_SIZE`): 同一层更多的条目由消费方带 offset 续取。

任一处只截断而不报总数, 用户看到的就是文件凭空消失 —— 这两个上限历史上
各自造成过一次这样的缺陷。

取数成本的两条硬约束 (都是实测出来的, 不是预防性优化):

- **节点的相对路径逐层拼接, 不对每个节点反查**。`ProjectSpace.relative()` 要
  `resolve()` 一次 (realpath 系统调用) 再 `relative_to`, 单节点约 60µs; 首屏
  6000 个节点就是 345ms, 占总耗时九成。起点的相对路径由路径空间反查一次,
  往下每层只做字符串拼接。安全边界不在这里: 读写一律经 `space.absolute()`
  的越界校验, 树只是展示投影。
- **遍历用 `os.scandir`**, 排序按 dirent 缓存里的类型判断, 不给每个条目 stat。
"""

from __future__ import annotations

import os
import stat
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from pathlib import Path

from service.content.domain.model import (
    OUTSIDE_GRANT_ERRORS,
    PATH_OUTSIDE_ROOT_ERROR,
    ROOT_UNAVAILABLE_ERROR,
    ContentError,
    root_relative,
    visible,
)
from service.content.service.enumeration import entry_from_stat
from service.content.service.repository import RepositoryLookup
from service.content.service.space import SEPARATOR, Mount, ProjectSpace
from service.content.service.utils import DIRECTORY_PATH_INVALID
from service.platform.content import (
    AssetKind,
    AssetOrigin,
    AssetPage,
    AssetTree,
    FileAssetRef,
    FlatResourceTree,
    ResourceEntry,
    ResourceTreeChanges,
    ResourceTreeGroup,
    RootKind,
)
from service.platform.storage import WINDOWS_PLATFORM

#: 单层单页返回的条目数上限, 防止超大目录拖垮渲染。
#:
#: 这是**每页**大小, 不是「最多只能看到这么多」: 超出的条目由调用方带 offset
#: 续取。它历史上是硬截断且不报总数, 于是上限之后的文件在界面上等于不存在。
PAGE_SIZE = 100

#: 默认递归深度。再深的层级等用户展开时按需请求。
DEFAULT_MAX_DEPTH = 3
PROJECT_TREE_DEPTH = 1


def _modified_at(entry: Path | os.DirEntry[str]) -> float | None:
    try:
        return entry.stat().st_mtime
    except FileNotFoundError:
        return None


def _is_plain_directory(entry: os.DirEntry[str]) -> bool:
    try:
        return entry.is_dir(follow_symlinks=False)
    except OSError:
        return False


def _join(parent: str, name: str) -> str:
    """拼相对项目根的子路径。parent 为空表示项目根。"""

    return f"{parent}{SEPARATOR}{name}" if parent else name


def _entries(directory: Path | int) -> list[os.DirEntry[str]]:
    """一层目录的全部可见条目, 目录在前、同类按名称排序。

    用 `os.scandir` 而不是 `Path.iterdir`: 排序要按「是不是目录」分组, 而
    `DirEntry.is_dir()` 读的是 readdir 已经带回来的 dirent 类型, `Path.is_file()`
    则是每个条目一次 stat。实测 5000 条的目录 16.8ms → 5.6ms。

    不在这里切页: 切页要在**挂载点合并之后**做, 否则挂载点可能被切掉 ——
    它们不是这个目录的磁盘条目, 却要出现在同一层里。
    """

    try:
        with os.scandir(directory) as scan:
            rows = [row for row in scan if visible(row.name)]
    except (OSError, PermissionError):
        if isinstance(directory, int):
            raise
        # 读不动的目录不应让整棵树失败, 呈现为空目录即可。
        return []
    # 这里调 is_dir() 同时把判定结果留在 DirEntry 的缓存里, 后面建节点不再问磁盘。
    rows.sort(key=lambda row: (not row.is_dir(), row.name.lower()))
    return rows


def _visible_count(directory: Path) -> int:
    """一层目录的可见条目数。

    单独一条路径而不复用 `_entries`: 数个数不需要排序 (排序才要判断每个条目是不是
    目录), 也不需要给每个条目造对象。被问到这个数的往往正是**不打算展开**的
    那一层, 那里数量最大而用处最小 —— 实测 5000 条的目录 16.8ms → 2.3ms。
    """

    try:
        with os.scandir(directory) as scan:
            return sum(1 for row in scan if visible(row.name))
    except (OSError, PermissionError):
        return 0


def _listing(
    space: ProjectSpace, directory: Path | int, relative: str, origin: AssetOrigin
) -> tuple[list[os.DirEntry[str] | Mount], set[str]]:
    """这一层的完整条目序列, 加上磁盘上真实存在的名字。

    磁盘条目在前, 生效中的挂载点并进来。挂载点遮住的真实同名目录不单列 ——
    由挂载节点带 `conflict` 标记呈现, 既不静默丢弃, 也不重复出两个同名节点。

    两样东西一起回: 判定「挂载点撞了真实同名目录」要用磁盘上的原始名字集合,
    而它和条目序列来自同一次 scandir, 分两次取就是把一层目录读两遍。
    """

    rows = [row for row in _entries(directory) if not space.excluded(_join(relative, row.name))]
    existing = {row.name for row in rows}
    mounts = (
        tuple(mount for mount in space.mounts_in(relative) if not space.excluded(mount.mount_path))
        if origin is AssetOrigin.LOCAL
        else ()
    )
    if not mounts:
        return list(rows), existing
    shadowed = {mount.name for mount in mounts}
    listing: list[os.DirEntry[str] | Mount] = [row for row in rows if row.name not in shadowed]
    listing.extend(mounts)
    return listing, existing


def _supports_incremental(scope: ProjectSpace) -> bool:
    # Authorized mounts can map multiple logical paths to the same file. Windows
    # keeps the full projection for junctions, reparse points, and path aliases.
    return not scope.mounts and os.name != WINDOWS_PLATFORM


def _ordinary_file(row: os.DirEntry[str]) -> bool:
    try:
        observed = row.stat(follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISREG(observed.st_mode) and observed.st_nlink == 1


def _child_total(space: ProjectSpace, directory: Path, relative: str, origin: AssetOrigin) -> int:
    """某个目录下的可见条目总数。

    只数不建节点: 建节点要递归扫子树, 而问到这个数的场合正是**不打算展开**
    的那一层 (深度上限之外)。
    """

    if not directory.is_dir():
        return 0
    mounts = space.mounts_in(relative) if origin is AssetOrigin.LOCAL else ()
    if not mounts and not space.excluded_paths:
        return _visible_count(directory)
    # 有挂载点才需要逐个比名字 (被遮蔽的同名目录不重复计数)。挂载点是个位数,
    # 这条分支极少走到, 所以不为它牺牲上面那条常见路径的成本。
    return len(_listing(space, directory, relative, origin)[0])


def _mount_node(
    space: ProjectSpace, mount: Mount, depth: int, conflict: bool, *, count_children: bool = True
) -> AssetTree:
    """挂载点节点。目录扫描子树；文件直接成为叶子，二者一律标 LINK。"""

    available = mount.source.is_dir() if mount.kind is AssetKind.DIR else mount.source.is_file()
    page = (
        _scan(space, mount.source, mount.mount_path, depth - 1, AssetOrigin.LINK)
        if mount.kind is AssetKind.DIR and depth > 1 and available
        else None
    )
    return AssetTree(
        asset=FileAssetRef(
            project_id=space.project.id,
            path=mount.mount_path,
            name=mount.name,
            kind=mount.kind,
            origin=AssetOrigin.LINK,
        ),
        children=page.children if page else (),
        # 外部根拔盘/被删时为 False: UI 要能区分「关联失效」与「空目录」。
        available=available,
        conflict=conflict,
        updated_at=(
            _modified_at(mount.source) if available and mount.kind is AssetKind.FILE else None
        ),
        child_total=(
            page.total
            if page
            else (
                _child_total(space, mount.source, mount.mount_path, AssetOrigin.LINK)
                if count_children and mount.kind is AssetKind.DIR
                else None
            )
        ),
    )


def _child_node(
    space: ProjectSpace,
    row: os.DirEntry[str],
    relative: str,
    depth: int,
    origin: AssetOrigin,
    *,
    count_children: bool = True,
    observations: dict[str, ResourceEntry | None] | None = None,
) -> AssetTree:
    """一个目录条目的节点。目录到了深度上限就不再下扫, 但要报出它有多少条目。

    `is_dir()` 走的是 `_entries` 排序时已填好的 dirent 缓存, `relative` 是父层
    拼下来的。文件仅对本页条目读取 stat，以投影最近修改时间。
    """

    is_dir = row.is_dir()
    asset = FileAssetRef(
        project_id=space.project.id,
        path=relative,
        name=row.name,
        kind=AssetKind.DIR if is_dir else AssetKind.FILE,
        origin=origin,
    )
    if observations is not None and "\\" not in row.name and not row.is_symlink():
        if is_dir:
            observations[relative] = None
        else:
            try:
                observed = row.stat(follow_symlinks=False)
            except (FileNotFoundError, PermissionError, NotADirectoryError):
                observed = None
            if observed is None:
                return AssetTree(asset=asset)
            if not stat.S_ISLNK(observed.st_mode):
                observations[relative] = (
                    entry_from_stat(relative, observed) if stat.S_ISREG(observed.st_mode) else None
                )
                return AssetTree(asset=asset, updated_at=observed.st_mtime)
    if not is_dir:
        return AssetTree(asset=asset, updated_at=_modified_at(row))
    target = Path(row.path)
    if depth > 1:
        page = _scan(space, target, relative, depth - 1, origin)
        return AssetTree(asset=asset, children=page.children, child_total=page.total)
    # 深度用尽: 不往下扫, 但「空目录」与「还没扫」必须分得开, 否则 UI 只能
    # 把没扫到的当成没有。
    return AssetTree(
        asset=asset,
        child_total=_child_total(space, target, relative, origin) if count_children else None,
    )


def _scan(
    space: ProjectSpace,
    directory: Path,
    relative: str,
    depth: int,
    origin: AssetOrigin,
    offset: int = 0,
) -> AssetPage:
    """扫描一层目录的一页。`relative` 是这一层相对项目根的路径。

    **先切页再建节点**: 建一个目录节点要递归扫它的子树, 为本页之外的条目做这件事
    是白烧 IO —— 一个上万条的目录会因此把整棵盘扫下来。
    """

    listing, existing = _listing(space, directory, relative, origin)
    start = min(max(0, offset), len(listing))
    nodes = tuple(
        (
            _mount_node(space, item, depth, conflict=item.name in existing)
            if isinstance(item, Mount)
            else _child_node(space, item, _join(relative, item.name), depth, origin)
        )
        for item in listing[start : start + PAGE_SIZE]
    )
    return AssetPage(children=nodes, total=len(listing), offset=start)


def build_tree(
    space: ProjectSpace,
    base: Path,
    *,
    max_depth: int = DEFAULT_MAX_DEPTH,
    offset: int = 0,
) -> AssetPage:
    """构建资料树的一页。base 是扫描起点 (某个根, 或用户展开到的某个子目录),
    相对基永远是项目根。

    起点目录不存在、或已不在路径空间内时返回空页而不是抛错: 新项目的文献库可能
    还没建, 而并发撤销授权/删除会让一个刚刚合法的起点失去归属 —— 这两种都不该
    让整棵树 500。

    起点的归属由路径空间反查, 不由调用方声明: 起点落在挂载点内部时整棵子树
    都是 LINK。让调用方传 origin 就等于允许它说谎, 而说谎的后果是关联子树被
    当成项目内副本 —— 用户以为在动副本, 其实动的是项目外的原文件。
    """

    resolved = base.expanduser().resolve()
    if not resolved.is_dir():
        return AssetPage()
    try:
        relative = space.relative(resolved)
    except ContentError:
        return AssetPage()
    if space.excluded(relative):
        return AssetPage()
    return _scan(space, resolved, relative, max_depth, space.origin(relative), offset)


@contextmanager
def _flat_listing(
    space: ProjectSpace, directory: Path, relative: str, origin: AssetOrigin, observe: bool
) -> Iterator[tuple[list[os.DirEntry[str] | Mount], set[str], bool]]:
    if observe:
        try:
            opened = space.open_directory(relative)
        except OSError:
            pass
        except ContentError as error:
            if error.code != DIRECTORY_PATH_INVALID:
                raise
        else:
            with closing(opened):
                try:
                    listing, existing = _listing(space, opened.fileno(), relative, origin)
                except OSError:
                    pass
                else:
                    yield listing, existing, True
                    return
    listing, existing = _listing(space, directory, relative, origin)
    yield listing, existing, False


def flat_tree(
    space: ProjectSpace,
    roots: tuple[str, ...],
    check_mount: Callable[[str], None],
    *,
    include_repositories: bool = False,
    track_parents: bool = False,
    observe_entries: bool = False,
    shallow: bool = False,
    on_directory: Callable[[tuple[AssetTree, ...], dict[str, str | None]], None] | None = None,
    check: Callable[[], None] | None = None,
) -> FlatResourceTree:
    """Return ordered resource rows without paging or pre-counting children."""

    if shallow:
        if len(roots) != 1:
            raise ContentError(PATH_OUTSIDE_ROOT_ERROR)
        start = roots[0]
        mount = space.mount_for(start)
        tail = start[len(mount.mount_path) :].strip(SEPARATOR) if mount is not None else start
        if any(not visible(part) for part in tail.split(SEPARATOR) if part):
            raise ContentError(PATH_OUTSIDE_ROOT_ERROR)
    pending = deque((root, False) for root in roots)
    visited: set[Path] = set()
    nodes: dict[str, AssetTree] = {}
    repositories: dict[str, str | None] = {}
    observations: dict[str, ResourceEntry | None] = {}
    parents: list[str] | None = [] if track_parents and _supports_incremental(space) else None
    lookup = RepositoryLookup(space) if include_repositories else None
    resource_root = root_relative(space.project.layout, RootKind.RESOURCES)
    # Mounted paths and Windows reparse points keep their separate resolution.
    reuse_directory_resolution = (
        lookup is not None and not space.mounts and os.name != WINDOWS_PLATFORM
    )
    observe_local = (
        (observe_entries or (shallow and track_parents))
        and _supports_incremental(space)
        and (shallow or roots == (resource_root,))
    )
    directory_asset: FileAssetRef | None = None
    while pending:
        if check is not None:
            check()
        path, classify_directory = pending.popleft()
        check_mount(path)
        # POSIX local children share the request's resolved project boundary.
        # Resolve the target again in case a queued directory became a link.
        try:
            directory = space.absolute(path, reuse_project_root=classify_directory)
        except ContentError as exc:
            if path in roots or exc.code not in OUTSIDE_GRANT_ERRORS:
                raise
            # Keep the discovered row, but do not descend beyond its grant.
            parents = None
            if lookup is not None:
                repositories[path] = None
            continue
        already_visited = directory in visited
        if already_visited and not classify_directory:
            continue
        is_directory = directory.is_dir()
        if lookup is not None and classify_directory:
            repositories[path] = lookup.for_resolved_local_path(
                directory, is_directory=is_directory
            )
        if already_visited or not is_directory:
            continue
        visited.add(directory)
        try:
            relative = (
                space.relative_resolved(directory)
                if classify_directory
                else space.relative(directory)
            )
        except ContentError:
            continue
        if space.excluded(relative):
            continue
        if parents is not None:
            if path == relative:
                parents.append(relative)
            else:
                parents = None
        origin = space.origin(relative)
        if shallow:
            directory_asset = FileAssetRef(
                space.project.id, relative, directory.name, AssetKind.DIR, origin
            )
        # Legacy inspection maps targets back to the resource root and filters
        # hidden ancestors. Retain it for ambiguous spellings and link targets.
        observe_directory = (
            observe_local
            and path == relative
            and (
                not resource_root
                or relative == resource_root
                or relative.startswith(f"{resource_root}{SEPARATOR}")
            )
            and "\\" not in relative
            and (not relative or all(visible(part) for part in relative.split(SEPARATOR)))
        )
        batch: list[AssetTree] | None = [] if on_directory is not None else None
        with _flat_listing(space, directory, relative, origin, observe_directory) as scan:
            listing, existing, pinned = scan
            if shallow and not pinned:
                parents = None
            for item in listing:
                if check is not None:
                    check()
                if isinstance(item, Mount):
                    check_mount(item.mount_path)
                    node = _mount_node(space, item, 1, item.name in existing, count_children=False)
                else:
                    node = _child_node(
                        space,
                        item,
                        _join(relative, item.name),
                        1,
                        origin,
                        count_children=False,
                        observations=observations if pinned and observe_entries else None,
                    )
                entry_path = node.asset.path
                nodes[entry_path] = node
                if batch is not None:
                    batch.append(node)
                descend = node.asset.kind is AssetKind.DIR and node.available
                if parents is not None and (
                    isinstance(item, Mount)
                    or "\\" in item.name
                    or (not _is_plain_directory(item) if descend else not _ordinary_file(item))
                ):
                    parents = None
                defer_repository = (
                    not shallow
                    and reuse_directory_resolution
                    and descend
                    and not isinstance(item, Mount)
                    and "\\" not in entry_path
                    and _is_plain_directory(item)
                )
                if lookup is not None:
                    repositories[entry_path] = (
                        None
                        if defer_repository
                        else lookup.for_entry(entry_path, directory, item, origin)
                    )
                if descend and not shallow:
                    pending.append((entry_path, defer_repository))
        if on_directory is not None and batch:
            on_directory(tuple(batch), repositories)
    if shallow and directory_asset is None:
        raise ContentError(ROOT_UNAVAILABLE_ERROR)
    return FlatResourceTree(
        tuple(nodes.values()),
        repositories,
        tuple(parents) if parents is not None else None,
        observations,
        directory_asset,
    )


def resource_tree_changes(
    space: ProjectSpace, paths: tuple[str, ...]
) -> ResourceTreeChanges | None:
    """Read the changed leaves and original sibling order without descending."""

    if not _supports_incremental(space):
        return None
    root = root_relative(space.project.layout, RootKind.RESOURCES)
    dirty: dict[str, set[str]] = {}
    for path in paths:
        if (
            (root and not path.startswith(f"{root}{SEPARATOR}"))
            or "\\" in path
            or "\0" in path
            or any(not part or not visible(part) for part in path.split(SEPARATOR))
            or space.excluded(path)
        ):
            return None
        parent, _, name = path.rpartition(SEPARATOR)
        dirty.setdefault(parent, set()).add(name)
    lookup = RepositoryLookup(space)
    nodes: list[AssetTree] = []
    repositories: dict[str, str | None] = {}
    groups: list[ResourceTreeGroup] = []
    for parent, names in dirty.items():
        ordered_paths: list[str] = []
        try:
            # Pin the authorized POSIX directory, then enumerate and stat via
            # its descriptor so a replaced ancestor cannot redirect the read.
            with closing(space.open_directory(parent)) as directory:
                listing, _ = _listing(space, directory.fileno(), parent, AssetOrigin.LOCAL)
                for row in listing:
                    if isinstance(row, Mount) or row.is_symlink():
                        return None
                    path = _join(parent, row.name)
                    ordered_paths.append(path)
                    if row.name in names:
                        if not _ordinary_file(row):
                            return None
                        nodes.append(
                            _child_node(
                                space, row, path, 1, AssetOrigin.LOCAL, count_children=False
                            )
                        )
                        repositories[path] = lookup.for_entry(
                            path, directory.path, row, AssetOrigin.LOCAL
                        )
        except OSError:
            return None
        except ContentError as error:
            if error.code != DIRECTORY_PATH_INVALID:
                raise
            return None
        groups.append(ResourceTreeGroup(parent, tuple(ordered_paths)))
    return ResourceTreeChanges(tuple(nodes), repositories, tuple(groups), root)


__all__ = ["DEFAULT_MAX_DEPTH", "PAGE_SIZE", "build_tree", "flat_tree", "resource_tree_changes"]
