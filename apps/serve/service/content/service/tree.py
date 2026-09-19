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
from pathlib import Path

from service.content.domain.model import ContentError, visible
from service.content.service.space import SEPARATOR, Mount, ProjectSpace
from service.platform.content import (
    AssetKind,
    AssetOrigin,
    AssetPage,
    AssetTree,
    FileAssetRef,
)

#: 单层单页返回的条目数上限, 防止超大目录拖垮渲染。
#:
#: 这是**每页**大小, 不是「最多只能看到这么多」: 超出的条目由调用方带 offset
#: 续取。它历史上是硬截断且不报总数, 于是上限之后的文件在界面上等于不存在。
PAGE_SIZE = 100

#: 默认递归深度。再深的层级等用户展开时按需请求。
DEFAULT_MAX_DEPTH = 3


def _join(parent: str, name: str) -> str:
    """拼相对项目根的子路径。parent 为空表示项目根。"""

    return f"{parent}{SEPARATOR}{name}" if parent else name


def _entries(directory: Path) -> list[os.DirEntry[str]]:
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
    space: ProjectSpace, directory: Path, relative: str, origin: AssetOrigin
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


def _mount_node(space: ProjectSpace, mount: Mount, depth: int, conflict: bool) -> AssetTree:
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
        child_total=(
            page.total
            if page
            else (
                _child_total(space, mount.source, mount.mount_path, AssetOrigin.LINK)
                if mount.kind is AssetKind.DIR
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
) -> AssetTree:
    """一个目录条目的节点。目录到了深度上限就不再下扫, 但要报出它有多少条目。

    `is_dir()` 走的是 `_entries` 排序时已填好的 dirent 缓存, `relative` 是父层
    拼下来的 —— 建一个节点因此不产生任何新的系统调用。
    """

    is_dir = row.is_dir()
    asset = FileAssetRef(
        project_id=space.project.id,
        path=relative,
        name=row.name,
        kind=AssetKind.DIR if is_dir else AssetKind.FILE,
        origin=origin,
    )
    if not is_dir:
        return AssetTree(asset=asset)
    target = Path(row.path)
    if depth > 1:
        page = _scan(space, target, relative, depth - 1, origin)
        return AssetTree(asset=asset, children=page.children, child_total=page.total)
    # 深度用尽: 不往下扫, 但「空目录」与「还没扫」必须分得开, 否则 UI 只能
    # 把没扫到的当成没有。
    return AssetTree(asset=asset, child_total=_child_total(space, target, relative, origin))


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


__all__ = ["DEFAULT_MAX_DEPTH", "PAGE_SIZE", "build_tree"]
