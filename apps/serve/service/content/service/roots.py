"""关联外部文件/目录的授权与撤销 (content 域, 开发 1 拥有)。

proposal 47 §5.1 选定的表达是**项目内虚拟挂载点**: 外部根登记成资料库根下
的一个挂载名, `FileAssetRef.path` 因此仍然只有「相对项目根」一种基准,
五个消费域的身份形状零变更。

两条语义在这里落地, 不留给调用方发挥:

- **挂载冲突**: 挂载点位置若已有真实同名条目, 直接拒 `mount_conflict`。
  静默避让会让用户以为自己的真实资料消失了; 改名让用户自己决定。
- **失效表达**: `available` 实测外部根当下是否可访问, 让 UI 能区分
  「关联失效」与「空目录」。

撤销是软撤销 (`revoked_at`): 能写用户项目外文件的能力, 撤销必须留痕。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path, PurePosixPath

from service.content.domain import naming
from service.content.domain.model import (
    ROOT_UNAVAILABLE_ERROR,
    ContentError,
    RootLocation,
    resolve_root,
)
from service.content.persistence.catalog import (
    AUDIT_AUTHORIZE,
    AUDIT_REVOKE,
    ContentCatalog,
    ExternalRootRow,
)
from service.persistence.project import SQLITE_PRIMARY_RESULT_MASK, reader, transaction
from service.platform.content import AssetKind, ExternalRootRef, ProjectRef, RootKind

#: 挂载名的长度上限 (UTF-8 字节)。挂载名镜像真实 OS 路径组件, 上限取各平台
#: 组件限制的最严值 (macOS/POSIX NAME_MAX = 255 字节); 只挡明显异常的输入,
#: 不拒绝 OS 合法的目录名。
MOUNT_NAME_MAX_BYTES = 255
OWNED_ROOT_TABLE = "content_owned_root"
OWNED_ROOT_CONFLICT = "owned_root_conflict"
OWNED_ROOT_UNAVAILABLE = "owned_root_unavailable"

#: 新源与已生效关联根存在包含关系时拒绝。同一份物理文件经两个嵌套挂载会得到
#: 两条「相对项目根」身份, 而文档读写按路径串寻址且无版本冲突检测, 两个页签
#: 会各自漂移 —— 这正是用户实测「A 路径与 B 路径打开同一文件内容不一致」的根因。
SOURCE_OVERLAP_ERROR = "source_overlap"

#: 反方向: 新源是某个已生效关联根的**父目录**。此时不是硬拒绝, 而是把选择交给
#: 用户 —— 可以「取代子关联并挂载父目录」(原子撤销子关联 + 挂载父目录), 也可以
#: 放弃挂载、直接打开已存在的子关联。前端凭已加载的关联根列表推出被覆盖的子关联。
SOURCE_COVERS_LINKS_ERROR = "source_covers_links"


def registered_roots(database: str) -> dict[RootKind, str]:
    """Read only explicit claims; inspecting a project must not create its database."""
    if not Path(database).is_file():
        return {}
    try:
        with reader(database) as connection:
            table = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                (OWNED_ROOT_TABLE,),
            ).fetchone()
            if table is None:
                return {}
            rows = connection.execute(f"SELECT kind, path FROM {OWNED_ROOT_TABLE}").fetchall()
            return {RootKind(row["kind"]): row["path"] for row in rows}
    except sqlite3.OperationalError as exc:
        if (
            getattr(exc, "sqlite_errorcode", 0) & SQLITE_PRIMARY_RESULT_MASK
            == sqlite3.SQLITE_CANTOPEN
        ):
            raise ContentError(ROOT_UNAVAILABLE_ERROR) from exc
        raise


def ensure_owned_root(database: str, location: RootLocation) -> None:
    """Claim a new root without silently adopting pre-existing user content.

    A crash after mkdir but before commit leaves an explicit conflict on retry,
    never permission to overwrite or to adopt an unproven directory.
    """
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {OWNED_ROOT_TABLE} (
                kind TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE
            )
        """)
        row = connection.execute(
            f"SELECT path FROM {OWNED_ROOT_TABLE} WHERE kind = ?", (location.kind.value,)
        ).fetchone()
        if row is not None:
            if row["path"] != location.relative or location.absolute.is_symlink():
                raise ContentError(OWNED_ROOT_CONFLICT)
            if not location.absolute.is_dir():
                raise ContentError(OWNED_ROOT_UNAVAILABLE)
            return
        try:
            location.absolute.mkdir(parents=False, exist_ok=False)
        except FileExistsError as error:
            raise ContentError(OWNED_ROOT_CONFLICT) from error
        except OSError as error:
            raise ContentError(OWNED_ROOT_UNAVAILABLE) from error
        connection.execute(
            f"INSERT INTO {OWNED_ROOT_TABLE} (kind, path) VALUES (?, ?)",
            (location.kind.value, location.relative),
        )


def mount_path_for(project: ProjectRef, name: str) -> str:
    """挂载名 → 相对项目根的挂载路径 (落在资料库根下)。"""

    relative = resolve_root(project, RootKind.RESOURCES).relative
    return f"{relative}/{name}" if relative else name


class ExternalRootService:
    """关联根登记表的域服务。`external_roots` 表只由本类改写。"""

    def __init__(self, catalog: ContentCatalog) -> None:
        self._catalog = catalog

    def authorize(
        self,
        project: ProjectRef,
        source: str,
        mount: str,
        *,
        nested: bool = False,
        supersede: bool = False,
    ) -> ExternalRootRef:
        return self.authorize_many(
            project, (source,), (mount,), nested=nested, supersede=supersede
        )[0]

    def authorize_many(
        self,
        project: ProjectRef,
        sources: tuple[str, ...],
        mounts: tuple[str, ...],
        *,
        nested: bool = False,
        supersede: bool = False,
    ) -> tuple[ExternalRootRef, ...]:
        if len(sources) != len(mounts) or not sources:
            raise ContentError("invalid_root_batch")
        rows = tuple(
            self._prepare(project, source, mount, nested=nested)
            for source, mount in zip(sources, mounts)
        )
        if len({row.source_path for row in rows}) != len(rows) or len(
            {row.mount_path for row in rows}
        ) != len(rows):
            raise ContentError("root_exists")
        covering = _covering_root_ids(
            tuple(Path(row.source_path) for row in rows), self._active_paths(project)
        )
        if covering and not supersede:
            raise ContentError(SOURCE_COVERS_LINKS_ERROR)
        try:
            return tuple(
                _root_ref(row)
                for row in self._catalog.authorize_external_roots(
                    rows, supersede_root_ids=covering if supersede else ()
                )
            )
        except sqlite3.IntegrityError as exc:
            raise ContentError("root_exists") from exc

    def _active_paths(self, project: ProjectRef) -> tuple[tuple[str, Path], ...]:
        return tuple(
            (row.root_id, Path(row.source_path)) for row in self._catalog.external_roots(project.id)
        )

    def assert_linkable(self, project: ProjectRef, sources: tuple[str, ...]) -> None:
        """关联导入创建任务前的**只读**包含预检。

        后台 job 执行时仍走 `authorize_many` 复检, 那里才是权威; 预检只为让资料库
        关联导入在创建任务的同一往返里就拿到方向化的错误码: 正向 (新源落在已生效
        根子树内) 报 `source_overlap` 硬拒绝; 反方向 (新源是已生效根的父目录) 报
        `source_covers_links`, 让前端弹「取代子关联 / 直接打开子关联」的选择。
        无法解析或不存在的源在此跳过, 交给 job 用 `source_not_found` 报告, 预检不抢答。
        """

        active = self._active_paths(project)
        if not active:
            return
        resolved: list[Path] = []
        for source in sources:
            try:
                candidate = Path(source).expanduser().resolve()
            except OSError:
                continue
            if candidate.exists():
                resolved.append(candidate)
        covering = _covering_root_ids(tuple(resolved), active)
        if covering:
            raise ContentError(SOURCE_COVERS_LINKS_ERROR)

    @staticmethod
    def _prepare(
        project: ProjectRef, source: str, mount: str, *, nested: bool = False
    ) -> ExternalRootRow:
        name = mount if nested else naming.normalize_display_name(mount)
        if not name:
            raise ContentError("mount_required")
        parts = name.split("/") if nested else [name]
        if (
            PurePosixPath(name).is_absolute()
            or "\\" in name
            or any(
                not part or len(part.encode("utf-8")) > MOUNT_NAME_MAX_BYTES or part in {".", ".."}
                for part in parts
            )
            or (not nested and "/" in name)
        ):
            raise ContentError("invalid_mount")

        resolved_source = Path(source).expanduser()
        try:
            resolved_source = resolved_source.resolve()
        except OSError as exc:
            raise ContentError("source_not_found") from exc
        if not resolved_source.exists():
            raise ContentError("source_not_found")
        if resolved_source.is_dir():
            kind = AssetKind.DIR
        elif resolved_source.is_file():
            kind = AssetKind.FILE
        else:
            raise ContentError("source_not_supported")

        project_root = Path(project.root).expanduser().resolve()
        if resolved_source == project_root or project_root in resolved_source.parents:
            # 项目内的文件或目录不需要授权; 登记成外部根会让越界校验出现两套答案。
            raise ContentError("source_inside_project")
        if resolved_source in project_root.parents:
            raise ContentError("source_contains_project")

        mount_path = mount_path_for(project, name)
        if (project_root / mount_path).exists():
            raise ContentError("mount_conflict")

        return ExternalRootRow(
            root_id=naming.new_project_id(),
            project_id=project.id,
            source_path=str(resolved_source),
            mount_path=mount_path,
            authorized_at=time.time(),
            kind=kind,
        )

    def revoke(self, root_id: str) -> None:
        row = self._catalog.external_root(root_id)
        if row is None:
            raise ContentError("unknown_root")
        if not self._catalog.revoke_external_root(root_id):
            raise ContentError("root_already_revoked")
        self._catalog.record(AUDIT_REVOKE, f"{row.mount_path} <- {row.source_path}", row.project_id)

    def active(self, project_id: str) -> tuple[ExternalRootRef, ...]:
        return tuple(_root_ref(row) for row in self._catalog.external_roots(project_id))

    def writable_roots(self, project: ProjectRef) -> tuple[str, ...]:
        """项目根 + 当前有效关联根。

        主进程白名单与 Agent 沙箱的 `writableRoots` 都从这一处派生;
        两套来源必然漂移成「一处能写一处不能写」。
        """

        roots = [str(Path(project.root).expanduser().resolve())]
        roots.extend(row.source_path for row in self._catalog.external_roots(project.id))
        return tuple(dict.fromkeys(roots))


def _root_ref(row: ExternalRootRow) -> ExternalRootRef:
    return ExternalRootRef(
        root_id=row.root_id,
        project_id=row.project_id,
        mount_path=row.mount_path,
        source_path=row.source_path,
        kind=row.kind,
        authorized_at=row.authorized_at,
        available=_available(Path(row.source_path), row.kind),
    )


def _available(source: Path, kind: AssetKind) -> bool:
    """来源仍存在且种类未变。种类变化不能伪装成原挂载仍然可用。"""

    return source.is_dir() if kind is AssetKind.DIR else source.is_file()


def _contains(parent: Path, child: Path) -> bool:
    """child 是否严格落在 parent 子树内 (相等不算)。"""

    return parent != child and parent in child.parents


def _overlaps(left: Path, right: Path) -> bool:
    """两条绝对路径是否存在包含关系 (任一方向)。"""

    return _contains(left, right) or _contains(right, left)


def _covering_root_ids(
    new: tuple[Path, ...], active: tuple[tuple[str, Path], ...]
) -> tuple[str, ...]:
    """方向化的包含判定, 返回被新源严格覆盖的已生效根 id。

    只比「新源 ↔ 旧根」与「新源 ↔ 新源」, 不比「旧根 ↔ 旧根」: 历史遗留的嵌套
    关联不应让一条无关的新授权也失败。完全相等的源由唯一索引兜成 `root_exists`,
    这里的包含判定是严格包含, 不会把相等误判成重叠。

    正向 (新源落在某个已生效根子树内) 与批内包含没有「取代」的合理语义, 直接抛
    `source_overlap` 硬拒绝; 只有反方向 (新源是已生效根的父目录) 才收集 id 交回,
    由调用方决定是硬拒绝还是走取代授权。
    """

    covering: list[str] = []
    for index, source in enumerate(new):
        for root_id, active_path in active:
            if _contains(active_path, source):
                raise ContentError(SOURCE_OVERLAP_ERROR)
            if _contains(source, active_path):
                covering.append(root_id)
        for other in new[index + 1 :]:
            if _overlaps(source, other):
                raise ContentError(SOURCE_OVERLAP_ERROR)
    return tuple(covering)


__all__ = [
    "MOUNT_NAME_MAX_BYTES",
    "SOURCE_COVERS_LINKS_ERROR",
    "SOURCE_OVERLAP_ERROR",
    "ExternalRootService",
    "mount_path_for",
]
