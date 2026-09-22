"""`ContentPort` 的唯一实现 (content 域, 开发 1 拥有)。

架构文档 §2.1 把 content 定为「文件与资产基础域, 不依赖任何上层业务域」。
本文件是该域对外能力的装配点: 把 `project_id` 解析成真实根目录, 再委托
`assets` / `tree` / `search` 三个原语模块。

为什么 project_id → root 的解析只在这里做:
其他域拿到的 `FileAssetRef.path` 全是相对路径, 只有本类知道绝对根在哪。
这样「绝对路径」这个危险概念被关在一个文件里, 越界校验也只有一处需要守。

项目身份来自 `content.sqlite3` (proposal 47 §6.3): `project_id` 是唯一身份键,
目录名只是可读装饰, 显示名可改而目录不动。工作区根与存量 `chat/projects.json`
的条目按 LEGACY 布局种入, 因此老项目的资料树取值与改造前逐字节一致。
"""

from __future__ import annotations

import hashlib
import io
import mimetypes
import os
import shutil
import stat
import tempfile
import threading
import time
from contextlib import nullcontext
from errno import ENOSPC
from pathlib import Path
from typing import Any, AsyncIterator, BinaryIO, Callable
from uuid import uuid4

from service.content.domain import naming
from service.content.domain.model import (
    MANAGED_LITERATURE_ROOT_RELATIVE,
    MANAGED_RESOURCES_ROOT_RELATIVE,
    OWNED_ROOT_KINDS,
    PATH_OUTSIDE_ROOT_ERROR,
    PROJECT_STATE_DIRNAME,
    ROOT_UNAVAILABLE_ERROR,
    ContentError,
    resolve_root,
    visible,
)
from service.content.persistence.catalog import (
    AUDIT_TRASH,
    SEED_ADOPTED,
    SEED_CHAT_REGISTRY,
    SEED_WORKSPACE,
    ContentCatalog,
    ProjectRow,
)
from service.content.service import (
    assets,
    enumeration,
    events,
    identity,
    migration,
    repository,
    roots,
    search,
    snapshot,
    space,
    token,
    tree,
)
from service.content.service.native import (
    exchange_entries,
    publish_descriptor,
    sync_published_descriptor,
)
from service.content.service.utils import directory, filesystem_error, read_regular
from service.paths import PROJECT_ARTIFACT_OBJECTS_RELATIVE, PROJECT_DB_RELATIVE
from service.platform.content import (
    DISK_FULL_ERROR,
    IMPORT_CANCELLED_ERROR,
    ArtifactScope,
    ArtifactScopeKind,
    ArtifactStorageLocation,
    AssetBinding,
    AssetKind,
    AssetPage,
    ContentImportCancellation,
    ContentImportObserver,
    ContentImportProgress,
    ContentImportResultObserver,
    ContentImportSourceResult,
    ContentImportStage,
    ContentSnapshot,
    ContentWriteReceipt,
    ExternalRootRef,
    FileAssetRef,
    FileEvent,
    ImportCollisionPolicy,
    ImportFailurePolicy,
    ImportMode,
    ImportSourceContent,
    ImportSourcePlan,
    PreparedContent,
    ProjectLayout,
    ProjectRef,
    ResourceEntry,
    ResourcePage,
    ResourceScanObserver,
    ResourceSearchResult,
    RootKind,
    StableContentCapture,
    StableContentSnapshot,
    VerifiedArtifactContent,
)
from service.platform.files import guess_media_type
from service.platform.resources import ProductMutationKind, ResourceChangeSink
from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    DirectoryHandle,
    preserve_mode,
    stable_read_matches,
)

#: 文本预览上限, 与原型的 2MB 一致。
MAX_TEXT_BYTES = 2 * 1024 * 1024

#: 工作台与 PDF 共用的字节流上限。覆盖 100MiB 本地资料及其小幅编辑增长。
MAX_BYTES = 128 * 1024 * 1024

#: 猜不出 MIME 时的兜底。
DEFAULT_MEDIA_TYPE = "application/octet-stream"

#: 强 revision 的稳定前缀；HTTP ETag 只负责加引号。
REVISION_PREFIX = "sha256:"

#: 流式计算摘要的块大小，避免大文件再复制一份到内存。
DIGEST_CHUNK_BYTES = 1024 * 1024
IMPORT_COPY_CHUNK_BYTES = 1024 * 1024
STABLE_READ_ATTEMPTS = 3
PRODUCT_MUTATION_KEY_PREFIX = "content"
IMPORT_GENERATION_PREFIX = "sha256:"

_FILE_LOCKS: dict[Path, threading.Lock] = {}
_FILE_LOCKS_GUARD = threading.Lock()


def _file_lock(path: Path) -> threading.Lock:
    """同一服务进程内，同一 canonical 文件只允许一个 CAS 提交者。"""

    with _FILE_LOCKS_GUARD:
        return _FILE_LOCKS.setdefault(path, threading.Lock())


def _revision(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(DIGEST_CHUNK_BYTES), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ContentError("read_failed") from exc
    return f"{REVISION_PREFIX}{digest.hexdigest()}"


def _copy_generation(plan: assets.CopyPlan) -> tuple[str, str | None]:
    """Hash the source tree generation represented by one immutable copy plan."""

    digest = hashlib.sha256()
    root_source = plan.directories[0].source if plan.directories else plan.files[0].source
    root_parent = root_source.resolve(strict=True).parent
    root_revision = None
    members = (*plan.directories, *plan.files)
    before = []
    for member in members:
        source = member.source.resolve(strict=True)
        state = source.stat()
        relative = source.relative_to(root_parent).as_posix()
        signature = (
            relative,
            str(state.st_dev),
            str(state.st_ino),
            str(state.st_mode),
            str(state.st_size),
            str(state.st_mtime_ns),
            str(state.st_ctime_ns),
        )
        before.append((source, signature))
        digest.update("\0".join(signature).encode("utf-8"))
        digest.update(b"\0")
        if source.is_file():
            revision = _revision(source)
            if source == root_source.resolve(strict=True):
                root_revision = revision
            digest.update(revision.encode("ascii"))
            digest.update(b"\0")
    for source, signature in before:
        state = source.stat()
        current = (
            signature[0],
            str(state.st_dev),
            str(state.st_ino),
            str(state.st_mode),
            str(state.st_size),
            str(state.st_mtime_ns),
            str(state.st_ctime_ns),
        )
        if current != signature:
            raise ContentError("content_source_changed")
    return f"{IMPORT_GENERATION_PREFIX}{digest.hexdigest()}", root_revision


def _bytes_revision(content: bytes) -> str:
    return f"{REVISION_PREFIX}{hashlib.sha256(content).hexdigest()}"


def _stable_source(path: Path) -> tuple[bytes, int]:
    """Read one bounded source generation before it is copied to a managed target."""

    for _attempt in range(STABLE_READ_ATTEMPTS):
        try:
            before = path.stat()
            if before.st_size > MAX_BYTES:
                raise ContentError("file_too_large")
            content = path.read_bytes()
            after = path.stat()
        except ContentError:
            raise
        except OSError as exc:
            raise ContentError("read_failed") from exc
        if (
            before.st_dev == after.st_dev
            and before.st_ino == after.st_ino
            and before.st_size == after.st_size == len(content)
            and before.st_mtime_ns == after.st_mtime_ns
            and before.st_ctime_ns == after.st_ctime_ns
        ):
            return content, stat.S_IMODE(after.st_mode)
    raise ContentError("file_not_stable")


class ProjectRegistry:
    """项目登记表。

    身份键是 26 位 ULID (`naming.new_project_id`), 落 `projects.project_id`;
    位置只来自 `projects.dir_root`; 时间只来自 `projects.created_at`。
    **禁止**从目录名反解上述任何一项 —— 目录名是给用户在访达里看的装饰。

    工作区根本身也是一条 LEGACY 记录: 不然「当前项目」就成了库外的第二套
    项目定义, 而两套定义并存正是本提案要消掉的问题。
    """

    #: 「当前项目」的稳定别名。前端与既有调用方传它或传 None 都取默认项目。
    CURRENT = "current"

    def __init__(self, workspace: str | None, catalog: ContentCatalog) -> None:
        self._workspace = str(workspace) if workspace else ""
        self._catalog = catalog

    # ---- 种入 ----

    def seed_workspace(self) -> ProjectRef | None:
        """把工作区根登记成项目 (若尚未登记)。

        布局取 LEGACY: 这个目录是用户自己选的, 里面的资料铺在根下,
        按 MANAGED 解析会让资料树立刻空掉。
        """

        if not self._workspace:
            return None
        return self._seed(Path(self._workspace), "", SEED_WORKSPACE)

    def seed_legacy(self, entries: tuple[tuple[Path, str], ...]) -> tuple[ProjectRef, ...]:
        """种入存量项目 (来源: chat 域的 `projects.json`, 只读种子)。"""

        seeded = [self._seed(path, name, SEED_CHAT_REGISTRY) for path, name in entries]
        return tuple(ref for ref in seeded if ref is not None)

    def _seed(self, path: Path, name: str, source: str) -> ProjectRef | None:
        resolved = str(path.expanduser().resolve())
        existing = self._catalog.project_by_root(resolved)
        if existing is not None:
            return _project_ref(existing)
        # 这里的 name 来自已存在的目录名或 chat 注册表, 不是本次用户输入:
        # 登记既有文件夹不该因为名字过长而失败, 所以夹取而不是像 create/rename 那样报错。
        raw = naming.normalize_display_name(name) or Path(resolved).name
        display = raw[: naming.DISPLAY_NAME_MAX]
        row = self._catalog.insert_project(
            ProjectRow(
                project_id=naming.new_project_id(),
                display_name=display,
                dir_root=resolved,
                layout=ProjectLayout.LEGACY.value,
                created_at=time.time(),
                seeded_from=source,
            )
        )
        return _project_ref(row)

    # ---- 查询 ----

    def default(self) -> ProjectRef:
        """当前默认项目 = 工作区根对应的那条记录。"""

        if not self._workspace:
            raise ContentError("no_project_selected")
        resolved = str(Path(self._workspace).expanduser().resolve())
        row = self._catalog.project_by_root(resolved)
        if row is None:
            raise ContentError("no_project_selected")
        return _project_ref(row)

    def resolve(self, project_id: str | None) -> ProjectRef:
        """project_id → 项目引用。None 或 CURRENT 取默认项目。"""

        if not project_id or project_id == self.CURRENT:
            return self.default()
        row = self._catalog.project(project_id)
        if row is None:
            # 未登记的 id 明确拒绝而不是静默回落到当前工作区 —— 静默回落会让
            # 调用方以为自己操作的是另一个项目。
            raise ContentError("unknown_project")
        return _project_ref(row)

    def projects(self) -> tuple[ProjectRef, ...]:
        return tuple(_project_ref(row) for row in self._catalog.projects())

    def for_path(self, absolute: str) -> ProjectRef | None:
        """绝对路径 → 所属项目。取最长匹配的 `dir_root`, 支持项目嵌套。"""

        try:
            target = Path(absolute).expanduser().resolve()
        except OSError:
            return None
        best: ProjectRow | None = None
        for row in self._catalog.projects():
            root = Path(row.dir_root)
            if target != root and root not in target.parents:
                continue
            if best is None or len(row.dir_root) > len(best.dir_root):
                best = row
        return _project_ref(best) if best is not None else None

    # ---- 变更 ----

    def create(self, name: str) -> ProjectRef:
        """新建 MANAGED 项目。用户只提交显示名, 身份与目录名由这里生成。"""

        display = naming.normalize_display_name(name)
        if not display:
            raise ContentError("name_required")
        if len(display) > naming.DISPLAY_NAME_MAX:
            raise ContentError("name_too_long")
        if not self._workspace:
            raise ContentError("no_workspace_root")
        workspace = Path(self._workspace).expanduser().resolve()
        project_id = naming.new_project_id()
        created_at = time.time()
        directory = workspace / naming.directory_name(project_id, display, created_at)
        if directory.exists():
            # 目录名带 40bit 随机段, 撞名意味着磁盘上已有异常残留, 不静默复用。
            raise ContentError("project_directory_exists")
        try:
            for relative in (
                MANAGED_RESOURCES_ROOT_RELATIVE,
                MANAGED_LITERATURE_ROOT_RELATIVE,
                PROJECT_STATE_DIRNAME,
            ):
                (directory / relative).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ContentError("project_create_failed") from exc
        row = self._catalog.insert_project(
            ProjectRow(
                project_id=project_id,
                display_name=display,
                dir_root=str(directory),
                layout=ProjectLayout.MANAGED.value,
                created_at=created_at,
            )
        )
        return _project_ref(row)

    def adopt(self, path: Path, name: str = "") -> ProjectRef:
        """把一个已存在的本地目录登记成 LEGACY 项目。

        与 `create` 的区别是「目录已经在那儿」: 用户手上就有资料的文件夹, 布局
        必须按 LEGACY 解析 (资料铺在根下), 否则资料树立刻空掉。
        这条路径保留是因为「添加已有文件夹」是用户的真实需求; 但它**不**让绝对
        路径重新变成身份 —— 登记后身份仍是 ULID, 目录只是位置。
        """

        target = path.expanduser()
        if not target.is_dir():
            raise ContentError("project_directory_not_found")
        resolved = target.resolve()
        existing = self._catalog.project_by_root(str(resolved))
        if existing is not None:
            return _project_ref(existing)
        seeded = self._seed(resolved, name, SEED_ADOPTED)
        if seeded is None:  # pragma: no cover - _seed 只在无工作区时回 None
            raise ContentError("project_create_failed")
        return seeded

    def rename(self, project_id: str, name: str) -> ProjectRef:
        """只改显示名。目录、已开会话 cwd、关联登记全部不动 (§5.2)。"""

        display = naming.normalize_display_name(name)
        if not display:
            raise ContentError("name_required")
        if len(display) > naming.DISPLAY_NAME_MAX:
            raise ContentError("name_too_long")
        if not self._catalog.rename_project(project_id, display):
            raise ContentError("unknown_project")
        return self.resolve(project_id)

    def set_archived(self, project_id: str, archived: bool) -> ProjectRef:
        """归档/解归档项目。只影响默认列表可见性 (§5.2: 目录与会话一律不动)。

        当前默认项目 (工作区根) 不能归档: 归档之后它在所有默认列表里消失, 而
        用户其实还在里面 —— 与 forget 的拒绝理由相同。
        """

        project = self.resolve(project_id)
        if (
            archived
            and self._workspace
            and project.root == str(Path(self._workspace).expanduser().resolve())
        ):
            raise ContentError("cannot_archive_current_project")
        if not self._catalog.set_project_archived(project.id, time.time() if archived else None):
            raise ContentError("unknown_project")
        return self.resolve(project_id)

    def forget(self, project_id: str) -> None:
        """把项目从书深移除。只摘登记, 不删磁盘。

        当前默认项目 (工作区根) 不能移除: 移掉之后 `project()` 无解, 界面会进入
        「没有项目」而用户并没有要求这件事。
        """

        project = self.resolve(project_id)
        if self._workspace and project.root == str(Path(self._workspace).expanduser().resolve()):
            raise ContentError("cannot_forget_current_project")
        if not self._catalog.delete_project(project.id):
            raise ContentError("unknown_project")


def _project_ref(row: ProjectRow) -> ProjectRef:
    """库行 → 跨域引用。`available` 是实测的, 不是存下来的状态。"""

    root = Path(row.dir_root)
    try:
        layout = ProjectLayout(row.layout)
    except ValueError:
        # 未知布局按 LEGACY 解析: 宁可按老规则显示资料, 也不要整个项目打不开。
        layout = ProjectLayout.LEGACY
    return ProjectRef(
        id=row.project_id,
        name=row.display_name,
        root=str(root),
        layout=layout,
        available=root.is_dir(),
        created_at=row.created_at,
        archived_at=row.archived_at,
    )


class ContentService:
    """`ContentPort` 的实现 (结构性满足该 Protocol)。"""

    def __init__(self, registry: ProjectRegistry, catalog: ContentCatalog) -> None:
        self._registry = registry
        self._catalog = catalog
        self._artifact_resolvers: dict[
            ArtifactScopeKind, Callable[[str], ArtifactStorageLocation]
        ] = {
            ArtifactScopeKind.PROJECT: self._project_artifact_storage,
        }
        self._roots = roots.ExternalRootService(catalog)
        self._tokens = token.TrashTokenVault()
        self._events = events.FileEventHub(catalog, self._rooted_space)
        self._migration = migration.MigrationService(catalog)
        self._resource_changes: ResourceChangeSink | None = None
        self._project_forget_sink: Callable[[str], None] | None = None

    def bind_resource_changes(self, sink: ResourceChangeSink) -> None:
        """Bind the product-owned mutation ledger at the composition root."""

        self._resource_changes = sink

    def bind_project_forget_sink(self, sink: Callable[[str], None]) -> None:
        """绑定「项目被永久删除」的跨域清理回调 (组合根接线, 文献域借此回收关联)。"""

        self._project_forget_sink = sink

    # ---- 存量迁移 ----

    def migration_plan(self, project_id: str) -> migration.MigrationPlan:
        return self._migration.plan(self._registry.resolve(project_id))

    def migrate_project(
        self,
        project_id: str,
        skip: tuple[str, ...] = (),
    ) -> migration.MigrationOutcome:
        outcome = self._migration.migrate(self._registry.resolve(project_id), skip)
        for move in outcome.moves:
            self._moved(outcome.project_id, move.source, move.target)
        return outcome

    # ---- 文件事件 ----

    def event_cursor(self, project_id: str) -> tuple[str, int]:
        return self._events.cursor(self._registry.resolve(project_id).id)

    def subscribe(self, project_id: str, epoch: str, from_seq: int) -> AsyncIterator[FileEvent]:
        return self._events.subscribe(self._registry.resolve(project_id).id, epoch, from_seq)

    async def close_events(self) -> None:
        """停掉监听 (进程退出时由组合根调用)。"""

        await self._events.aclose()

    async def refresh_events(self, project_id: str) -> None:
        """Refresh the Content-owned watcher for a registered project."""

        await self._events.ensure_watching(self._registry.resolve(project_id).id)

    def _wrote(self, project_id: str, *paths: str) -> None:
        """登记产品自身的写入, 抑制 watcher 把它回灌成外部事件。

        每个真的动了磁盘的 Port 方法都必须过这里 —— 漏一个就会出现「产品写入
        → 事件 → 前端刷新」的自激循环, 而那种抖动很难从日志里看出来源。
        """

        for path in paths:
            if path:
                self._events.suppress(project_id, path)
        if self._resource_changes is not None:
            self._resource_changes.record_changes(project_id, tuple(path for path in paths if path))

    def _moved(self, project_id: str, source: str, target: str) -> None:
        """Publish the structural identity change after suppressing watcher echoes."""

        for path in (source, target):
            self._events.suppress(project_id, path)
        if self._resource_changes is not None:
            self._resource_changes.record_move(project_id, source, target)

    # ---- 路径空间 ----

    def _space(self, project_id: str | None) -> space.ProjectSpace:
        """该项目当前的路径空间 (项目根 + 生效中的虚拟挂载)。

        每次调用都重建而不是缓存: 授权与撤销必须**即时**在产品面生效
        (proposal 47 §6.9 的生效语义表), 缓存一份挂载表就等于给已撤销的根留
        一个还能写的窗口。重建的成本是一次索引查询。
        """

        project = self._registry.resolve(project_id)
        if not project.available:
            raise ContentError(ROOT_UNAVAILABLE_ERROR)
        mounts = tuple(
            space.Mount(
                mount_path=row.mount_path,
                source=Path(row.source_path),
                kind=row.kind,
                root_id=row.root_id,
            )
            for row in self._catalog.external_roots(project.id)
        )
        return space.ProjectSpace(project, mounts)

    def _identity_space(self, project_id: str) -> space.ProjectSpace:
        """Verification-only view that preserves revoked root lineage without write authority."""

        project = self._registry.resolve(project_id)
        mounts = tuple(
            space.Mount(
                mount_path=row.mount_path,
                source=Path(row.source_path),
                kind=row.kind,
                root_id=row.root_id,
            )
            for row in self._catalog.external_roots(project.id, include_revoked=True)
        )
        return space.ProjectSpace(project, mounts)

    # ---- 路径与读写 ----

    def _rooted_space(self, project_id: str) -> space.ProjectSpace:
        scope = self._space(project_id)
        owned = roots.registered_roots(self.resolve(scope.project.id, PROJECT_DB_RELATIVE))
        return space.ProjectSpace(scope.project, scope.mounts, owned_roots=owned)

    def _resource_space(self, project_id: str) -> space.ProjectSpace:
        scope = self._rooted_space(project_id)
        return space.ProjectSpace(
            scope.project,
            scope.mounts,
            owned_roots=scope.owned_roots,
            excluded_paths=tuple(scope.owned_roots.values()),
        )

    def resolve(self, project_id: str, path: str) -> str:
        return str(self._space(project_id).absolute(path))

    def locate(
        self,
        project_id: str,
        root: RootKind,
        absolute_path: str,
    ) -> FileAssetRef | None:
        """把绝对路径安全地反解为指定业务根内的项目相对身份。"""

        scope = self._rooted_space(project_id)
        if root in OWNED_ROOT_KINDS and root not in scope.owned_roots:
            return None
        location = resolve_root(scope.project, root)
        candidate = Path(absolute_path).expanduser().resolve()
        if root is RootKind.RESOURCES and any(
            candidate.is_relative_to(Path(scope.project.root) / relative)
            for relative in scope.owned_roots.values()
        ):
            return None
        try:
            relative_to_root = candidate.relative_to(location.absolute.resolve())
        except ValueError:
            return None
        relative = (
            Path(location.relative, relative_to_root).as_posix()
            if location.relative
            else relative_to_root.as_posix()
        )
        return FileAssetRef(
            project_id=scope.project.id,
            path=relative,
            name=candidate.name,
            kind=AssetKind.FILE if candidate.is_file() else AssetKind.DIR,
        )

    def exists(self, project_id: str, path: str) -> bool:
        try:
            return self._space(project_id).absolute(path).exists()
        except ContentError:
            # 越界路径不算「存在」, 但也不该让调用方为此处理异常: 它问的是
            # 「这里有东西吗」, 而越界的答案就是没有。
            return False

    def is_directory(self, project_id: str, path: str) -> bool:
        try:
            return self._space(project_id).absolute(path).is_dir()
        except ContentError:
            return False

    def _file(self, project_id: str, path: str) -> Path:
        target = self._space(project_id).absolute(path)
        if not target.is_file():
            raise ContentError("file_not_found")
        return target

    def read_text(self, project_id: str, path: str) -> str:
        target = self._file(project_id, path)
        if target.stat().st_size > MAX_TEXT_BYTES:
            raise ContentError("file_too_large")
        try:
            return target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ContentError("not_text_file") from exc

    def write_text(self, project_id: str, path: str, content: str) -> FileAssetRef:
        """原子写入文本资产。目标不存在时按给定路径新建。

        不存在即新建 (而不是报 `file_not_found`) 的理由: 调用方给的是**确定**
        的相对路径 (编辑器保存的那份文档、文献库 JSON)。若要求先 `create`,
        那条路径会走同名避让逻辑变成 `xxx (2).json`, 于是产品状态文件每次
        都落在新名字上。同名避让只适用于「用户新建」, 不适用于确定路径写入。
        """

        scope = self._space(project_id)
        target = scope.absolute(path)
        payload = content.encode("utf-8")
        if self._resource_changes is not None:
            kind = ProductMutationKind.WRITE if target.exists() else ProductMutationKind.CREATE
            receipt = self._resource_changes.commit_product_bytes(
                scope.project.id,
                path,
                payload,
                kind,
                f"{PRODUCT_MUTATION_KEY_PREFIX}:{uuid4().hex}",
            )
            if receipt is not None:
                return assets.node_for(scope, target)
        self._replace_bytes(project_id, path, payload, None, b"")
        return assets.node_for(scope, scope.absolute(path))

    def read_bytes(
        self, project_id: str, path: str, max_bytes: int = MAX_BYTES
    ) -> tuple[bytes, str]:
        target = self._file(project_id, path)
        media = guess_media_type(target.name)
        scope = self._space(project_id)
        parent: DirectoryHandle | None = None
        try:
            parent, name = scope.open_parent(scope.relative(target))
            payload = read_regular(parent, name, max_bytes)
            return payload, media or DEFAULT_MEDIA_TYPE
        except OSError as exc:
            raise ContentError("read_failed") from exc
        finally:
            if parent is not None:
                parent.close()

    def read_scoped_bytes(
        self, project_id: str, path: str, directory_path: str
    ) -> tuple[bytes, str]:
        """Read the checked target without resolving its logical symlink again."""
        root = self._space(project_id).absolute(directory_path)
        target = self._file(project_id, path)
        if not root.is_dir() or not target.is_relative_to(root):
            raise ContentError("source_forbidden")
        relative = target.relative_to(root)
        media, _ = mimetypes.guess_type(target.name)
        try:
            # Every ancestor is opened no-follow, and the final read stays relative
            # to that pinned descriptor even if a logical path is replaced.
            with directory(root, tuple(relative.parent.parts)) as parent:
                payload = read_regular(parent, relative.name, MAX_BYTES)
        except OSError as exc:
            raise ContentError("read_failed") from exc
        return payload, media or DEFAULT_MEDIA_TYPE

    def read_asset_bytes(
        self, project_id: str, asset_id: str, max_bytes: int = MAX_BYTES
    ) -> tuple[bytes, str]:
        try:
            payload, asset = identity.read(
                self._space(project_id),
                self.resolve(project_id, PROJECT_DB_RELATIVE),
                asset_id,
                max_bytes,
            )
        except OSError as error:
            raise ContentError("read_failed") from error
        media, _ = mimetypes.guess_type(asset.name)
        return payload, media or DEFAULT_MEDIA_TYPE

    def identify(self, project_id: str, path: str) -> AssetBinding:
        return identity.identify(
            self._space(project_id), self.resolve(project_id, PROJECT_DB_RELATIVE), path
        )

    def asset_status(self, project_id: str, asset_id: str) -> AssetBinding:
        resolved_project_id = self._registry.resolve(project_id).id
        active_root_ids = frozenset(
            row.root_id for row in self._catalog.external_roots(resolved_project_id)
        )
        return identity.status(
            self._identity_space(resolved_project_id),
            self.resolve(resolved_project_id, PROJECT_DB_RELATIVE),
            asset_id,
            active_root_ids,
        )

    def rebind_asset(self, project_id: str, source: str, destination: str) -> AssetBinding | None:
        return identity.rebind(
            self._space(project_id),
            self.resolve(project_id, PROJECT_DB_RELATIVE),
            source,
            destination,
        )

    def create_bytes(self, project_id: str, parent: str, name: str, content: bytes) -> FileAssetRef:
        scope = self._space(project_id)
        created = assets.create_bytes_document(scope, parent, name, content)
        self._wrote(scope.project.id, created.path)
        return created

    def read_import_source(self, project_id: str, source: str) -> ImportSourceContent:
        self.project(project_id)
        if not source.strip() or "\x00" in source:
            raise ContentError("source_not_found")
        selected = Path(source).expanduser()
        if not selected.is_absolute():
            raise ContentError("source_not_found")
        try:
            target = selected.resolve(strict=True)
            with directory(target.parent, ()) as parent:
                payload = read_regular(parent, target.name, MAX_BYTES)
        except FileNotFoundError as error:
            raise ContentError("source_not_found") from error
        except OSError as error:
            raise ContentError("read_failed") from error
        media, _ = mimetypes.guess_type(target.name)
        return ImportSourceContent(target.name, payload, media or DEFAULT_MEDIA_TYPE)

    def plan_import_sources(
        self,
        project_id: str,
        sources: tuple[str, ...],
        target_dir: str,
    ) -> tuple[ImportSourcePlan, ...]:
        """Describe the exact requested and collision-free COPY targets without writing."""

        scope = self._space(project_id)
        copy_plans = assets.import_plans(scope, sources, target_dir)
        planned: list[ImportSourcePlan] = []
        parent = scope.absolute(target_dir)
        for index, (raw, copy_plan) in enumerate(zip(sources, copy_plans)):
            selected = Path(raw).expanduser()
            source = selected.resolve(strict=True)
            source_state = source.stat()
            requested = parent / selected.name
            target_kind = None
            target_revision = None
            target_size = None
            source_generation, source_revision = _copy_generation(copy_plan)
            if requested.exists():
                if requested.is_file():
                    target_kind = AssetKind.FILE
                    target_size = requested.stat().st_size
                    target_revision = _revision(requested)
                elif requested.is_dir():
                    target_kind = AssetKind.DIR
                    target_size = requested.stat().st_size
                else:
                    raise ContentError("target_not_found")
            planned.append(
                ImportSourcePlan(
                    source_index=index,
                    source_name=selected.name,
                    source_kind=AssetKind.DIR if source.is_dir() else AssetKind.FILE,
                    source_generation=source_generation,
                    source_revision=source_revision,
                    source_size=source_state.st_size,
                    source_mode_bits=stat.S_IMODE(source_state.st_mode),
                    requested_path=scope.relative(requested),
                    target_path=scope.relative(copy_plan.root),
                    conflict=copy_plan.root != requested,
                    target_kind=target_kind,
                    target_revision=target_revision,
                    target_size=target_size,
                )
            )
        return tuple(planned)

    def prepare_bytes(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        reserved_paths: tuple[str, ...] = (),
    ) -> PreparedContent:
        if len(content) > MAX_BYTES:
            raise ContentError("file_too_large")
        return assets.prepare_bytes_document(
            self._space(project_id), parent, name, content, reserved_paths
        )

    def publish_prepared(self, prepared: PreparedContent) -> FileAssetRef:
        """Publish staged bytes; materialize notifies mutation sinks after commit."""

        return assets.publish_prepared(self._space(prepared.project_id), prepared)

    def prepared_asset(self, prepared: PreparedContent) -> FileAssetRef:
        return assets.prepared_asset(self._space(prepared.project_id), prepared)

    def validate_prepared(self, prepared: PreparedContent) -> None:
        assets.validate_prepared(prepared)

    def materialize(self, prepared: PreparedContent) -> FileAssetRef:
        self.validate_prepared(prepared)
        created = identity.materialize(
            self._space(prepared.project_id),
            self.resolve(prepared.project_id, PROJECT_DB_RELATIVE),
            prepared,
            self.publish_prepared,
            self.release_prepared,
        )
        # identity.materialize holds the shared project database write lock while
        # publishing. Resource-version notification opens that same database, so
        # it must run after the identity transaction commits. Notify on replays as
        # well so a prior post-commit notification failure remains recoverable.
        self._wrote(prepared.project_id, created.path)
        return created

    def asset(
        self, project_id: str, asset_id: str, *, creation: PreparedContent | None = None
    ) -> FileAssetRef:
        if creation is not None:
            self.validate_prepared(creation)
        return identity.lookup(
            self._space(project_id),
            self.resolve(project_id, PROJECT_DB_RELATIVE),
            asset_id,
            creation=creation,
        )

    def release_prepared(self, prepared: PreparedContent) -> None:
        assets.release_prepared(self._space(prepared.project_id), prepared)

    def read_optional_bytes(self, project_id: str, path: str, default: bytes) -> bytes:
        target = self._space(project_id).absolute(path)
        if not target.exists():
            return default
        if not target.is_file():
            raise ContentError("not_a_file")
        if target.stat().st_size > MAX_BYTES:
            raise ContentError("file_too_large")
        try:
            return target.read_bytes()
        except OSError as exc:
            raise ContentError("read_failed") from exc

    def files(self, project_id: str) -> tuple[FileAssetRef, ...]:
        """递归列出项目根内的普通文件，不沿符号链接越出项目。"""

        scope = self._space(project_id)
        found: list[FileAssetRef] = []
        for directory, names, filenames in os.walk(scope.root, followlinks=False):
            base = Path(directory)
            names[:] = [name for name in names if visible(name) and not (base / name).is_symlink()]
            for name in filenames:
                target = base / name
                if visible(name) and target.is_file() and not target.is_symlink():
                    found.append(assets.node_for(scope, target))
        return tuple(found)

    def revision(self, content: bytes) -> str:
        return _bytes_revision(content)

    def snapshot(self, project_id: str, path: str) -> ContentSnapshot:
        target = self._file(project_id, path)
        try:
            size = target.stat().st_size
        except OSError as exc:
            raise ContentError("read_failed") from exc
        media = guess_media_type(target.name)
        return ContentSnapshot(
            project_id=project_id or ProjectRegistry.CURRENT,
            path=path,
            media_type=media or DEFAULT_MEDIA_TYPE,
            size=size,
            revision=_revision(target),
        )

    def stable_snapshot(self, project_id: str, path: str, max_bytes: int) -> StableContentSnapshot:
        """Read one bounded stable generation using stat-read-stat validation."""

        target = self._file(project_id, path)
        for _attempt in range(STABLE_READ_ATTEMPTS):
            try:
                before = target.stat()
                if before.st_size > max_bytes:
                    raise ContentError("file_too_large")
                content = target.read_bytes()
                after = target.stat()
            except ContentError:
                raise
            except OSError as exc:
                raise ContentError("read_failed") from exc
            if (
                before.st_dev == after.st_dev
                and before.st_ino == after.st_ino
                and before.st_size == after.st_size == len(content)
                and before.st_mtime_ns == after.st_mtime_ns
                and before.st_ctime_ns == after.st_ctime_ns
            ):
                media = guess_media_type(target.name)
                return StableContentSnapshot(
                    project_id=project_id or ProjectRegistry.CURRENT,
                    path=path,
                    media_type=media or DEFAULT_MEDIA_TYPE,
                    content=content,
                    revision=_bytes_revision(content),
                    mtime_ns=after.st_mtime_ns,
                    mode_bits=stat.S_IMODE(after.st_mode),
                )
        raise ContentError("file_not_stable")

    def capture_stable(
        self,
        project_id: str,
        path: str,
        max_bytes: int,
        target: BinaryIO,
    ) -> StableContentCapture:
        """Copy one bounded generation through a pinned no-follow file descriptor."""

        scope = self._space(project_id)
        parent: DirectoryHandle | None = None
        try:
            parent, name = scope.open_parent(path)
            for _attempt in range(STABLE_READ_ATTEMPTS):
                target.seek(0)
                target.truncate(0)
                descriptor = parent.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
                with os.fdopen(descriptor, "rb") as stream:
                    before = os.fstat(stream.fileno())
                    if not stat.S_ISREG(before.st_mode):
                        raise ContentError("not_a_file")
                    if before.st_size > max_bytes:
                        raise ContentError("file_too_large")
                    digest = hashlib.sha256()
                    copied = 0
                    for chunk in iter(lambda: stream.read(DIGEST_CHUNK_BYTES), b""):
                        copied += len(chunk)
                        if copied > max_bytes:
                            raise ContentError("file_too_large")
                        digest.update(chunk)
                        target.write(chunk)
                    after = os.fstat(stream.fileno())
                current = parent.stat(name)
                if stable_read_matches(before, after, current, copied):
                    target.flush()
                    target.seek(0)
                    media = guess_media_type(name)
                    return StableContentCapture(
                        project_id=project_id or ProjectRegistry.CURRENT,
                        path=path,
                        media_type=media or DEFAULT_MEDIA_TYPE,
                        size=copied,
                        revision=f"{REVISION_PREFIX}{digest.hexdigest()}",
                        mtime_ns=after.st_mtime_ns,
                        mode_bits=stat.S_IMODE(after.st_mode),
                    )
            raise ContentError("file_not_stable")
        except FileNotFoundError as exc:
            raise ContentError("file_not_found") from exc
        except OSError as exc:
            if exc.errno == ENOSPC:
                raise ContentError(DISK_FULL_ERROR) from exc
            raise filesystem_error(exc, "read_failed") from exc
        finally:
            if parent is not None:
                parent.close()

    def bind_artifact_scope(
        self, kind: ArtifactScopeKind, resolver: Callable[[str], ArtifactStorageLocation]
    ) -> None:
        if kind in self._artifact_resolvers:
            raise ValueError("artifact scope already registered")
        self._artifact_resolvers[kind] = resolver

    def _project_artifact_storage(self, project_id: str) -> ArtifactStorageLocation:
        scope = self._space(project_id)
        return ArtifactStorageLocation(
            source_root=str(scope.root),
            storage_root=str(scope.root),
            objects_relative=PROJECT_ARTIFACT_OBJECTS_RELATIVE,
            database=self.resolve(project_id, PROJECT_DB_RELATIVE),
        )

    def artifact_storage(self, scope: ArtifactScope) -> ArtifactStorageLocation:
        resolver = self._artifact_resolvers.get(scope.kind)
        if not scope.id.strip() or resolver is None:
            raise ContentError(snapshot.PATH_INVALID)
        return resolver(scope.id)

    def capture_artifact(
        self, scope: ArtifactScope, path: str, expected_sha256: str = ""
    ) -> VerifiedArtifactContent:
        location = self.artifact_storage(scope)
        if not path.strip() or Path(path).is_absolute():
            raise ContentError(snapshot.PATH_INVALID)
        target = (Path(location.source_root) / path).resolve()
        return snapshot.capture(location, scope, target, expected_sha256=expected_sha256)

    def read_artifact(self, content: VerifiedArtifactContent) -> bytes:
        return snapshot.read(self.artifact_storage(content.scope), content)

    def read_range(self, project_id: str, path: str, start: int, end: int) -> bytes:
        target = self._file(project_id, path)
        if start < 0 or end < start:
            raise ContentError("invalid_range")
        try:
            with target.open("rb") as stream:
                stream.seek(start)
                return stream.read(end - start + 1)
        except OSError as exc:
            raise ContentError("read_failed") from exc

    def commit_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
    ) -> ContentWriteReceipt:
        return self._replace_bytes(project_id, path, content, expected_revision, None)

    def commit_optional_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
        default: bytes,
    ) -> ContentWriteReceipt:
        """CAS 新建或替换产品辅助文件，不把缺失误判成无版本。"""

        return self._replace_bytes(project_id, path, content, expected_revision, default)

    def _replace_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str | None,
        default: bytes | None,
        *,
        mode_bits: int | None = None,
        notify: bool = True,
    ) -> ContentWriteReceipt:
        """One owner for text saves and both CAS policies; None default requires a file."""

        return self._replace_stream(
            project_id,
            path,
            io.BytesIO(content),
            len(content),
            _bytes_revision(content),
            expected_revision,
            default,
            mode_bits=mode_bits,
            notify=notify,
            max_bytes=MAX_BYTES,
        )

    def _replace_stream(
        self,
        project_id: str,
        path: str,
        content: BinaryIO,
        size: int,
        revision: str,
        expected_revision: str | None,
        default: bytes | None,
        *,
        mode_bits: int | None = None,
        notify: bool = True,
        max_bytes: int | None = None,
    ) -> ContentWriteReceipt:
        """Atomically install an exact bounded stream through the Content filesystem owner."""

        if size < 0 or (max_bytes is not None and size > max_bytes):
            raise ContentError("file_too_large")
        scope = self._space(project_id)
        target = scope.absolute(path)
        if target.is_dir():
            raise ContentError("not_a_file")
        if default is None and not target.is_file():
            raise ContentError("file_not_found")
        lock = _file_lock(target)
        temporary: str | None = None
        directory: DirectoryHandle | None = None
        stage_descriptor: int | None = None
        stage_identity: os.stat_result | None = None
        with lock:
            try:
                directory, target_name = scope.open_parent(path, create=default is not None)
                parent_descriptor = directory

                def observed(name: str = target_name) -> tuple[str, os.stat_result | None]:
                    try:
                        descriptor = parent_descriptor.open(
                            name,
                            os.O_RDONLY | NOFOLLOW | NONBLOCK,
                        )
                    except FileNotFoundError:
                        if default is None:
                            raise ContentError("file_not_found")
                        return _bytes_revision(default), None
                    with os.fdopen(descriptor, "rb") as stream:
                        physical = os.fstat(stream.fileno())
                        if not stat.S_ISREG(physical.st_mode):
                            raise ContentError("not_a_file")
                        digest = hashlib.sha256()
                        for chunk in iter(lambda: stream.read(DIGEST_CHUNK_BYTES), b""):
                            digest.update(chunk)
                        return f"{REVISION_PREFIX}{digest.hexdigest()}", physical

                current_revision, original = observed()
                if expected_revision is not None and current_revision != expected_revision:
                    raise ContentError("revision_conflict")
                original_mode = (
                    mode_bits
                    if mode_bits is not None
                    else (
                        stat.S_IMODE(original.st_mode)
                        if original is not None
                        else assets.CREATE_TEMP_MODE
                    )
                )
                temporary = f"{assets.CREATE_TEMP_PREFIX}{uuid4().hex}"
                staged_name = temporary
                stage_descriptor = parent_descriptor.open(
                    staged_name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                    assets.CREATE_TEMP_MODE,
                )
                with os.fdopen(os.dup(stage_descriptor), "wb") as stream:
                    content.seek(0)
                    copied = 0
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: content.read(IMPORT_COPY_CHUNK_BYTES), b""):
                        copied += len(chunk)
                        if copied > size:
                            raise ContentError("prepared_content_conflict")
                        digest.update(chunk)
                        stream.write(chunk)
                    if copied != size or f"{REVISION_PREFIX}{digest.hexdigest()}" != revision:
                        raise ContentError("prepared_content_conflict")
                    stream.flush()
                    preserve_mode(stream.fileno(), original_mode)
                    os.fsync(stream.fileno())
                stage_identity = os.fstat(stage_descriptor)
                staged_identity = stage_identity
                parent_descriptor.sync()

                def publish() -> None:
                    observed_revision, before = observed()
                    if expected_revision is not None and observed_revision != expected_revision:
                        raise ContentError("revision_conflict")
                    if before is None:
                        if stage_descriptor is None:
                            raise ContentError("prepared_content_conflict")
                        physical = os.fstat(stage_descriptor)
                        if (physical.st_dev, physical.st_ino) != (
                            staged_identity.st_dev,
                            staged_identity.st_ino,
                        ):
                            raise ContentError("prepared_content_conflict")
                        publish_descriptor(stage_descriptor, parent_descriptor, target_name)
                        sync_published_descriptor(
                            stage_descriptor,
                            parent_descriptor,
                            target_name,
                        )
                    else:
                        exchange_entries(parent_descriptor, staged_name, target_name)
                        try:
                            installed = parent_descriptor.stat(target_name)
                            displaced = parent_descriptor.stat(staged_name)
                            if (
                                (installed.st_dev, installed.st_ino)
                                != (staged_identity.st_dev, staged_identity.st_ino)
                                or (displaced.st_dev, displaced.st_ino)
                                != (before.st_dev, before.st_ino)
                                or observed()[0] != revision
                                or (
                                    expected_revision is not None
                                    and observed(staged_name)[0] != expected_revision
                                )
                            ):
                                raise ContentError("prepared_content_conflict")
                        except (OSError, ContentError):
                            exchange_entries(parent_descriptor, staged_name, target_name)
                            parent_descriptor.sync()
                            raise
                    parent_descriptor.sync()

                identity.replace_file(
                    scope,
                    self.resolve(scope.project.id, PROJECT_DB_RELATIVE),
                    scope.relative(target),
                    staged_name,
                    publish,
                    sha256=revision.removeprefix(REVISION_PREFIX),
                    previous_sha256=(
                        expected_revision.removeprefix(REVISION_PREFIX)
                        if expected_revision is not None
                        else None
                    ),
                )
                # Only a successfully committed exchange may release the old file.
                cleanup_identity = original or staged_identity
                if cleanup_identity is not None:
                    try:
                        displaced = parent_descriptor.stat(staged_name)
                    except FileNotFoundError:
                        pass
                    else:
                        if (displaced.st_dev, displaced.st_ino) == (
                            cleanup_identity.st_dev,
                            cleanup_identity.st_ino,
                        ):
                            parent_descriptor.unlink(staged_name)
                temporary = None
            except ContentError:
                raise
            except OSError as exc:
                raise filesystem_error(exc, assets.WRITE_FAILED, target) from exc
            finally:
                try:
                    if (
                        temporary is not None
                        and directory is not None
                        and stage_identity is not None
                    ):
                        try:
                            remaining = directory.stat(temporary)
                            if (remaining.st_dev, remaining.st_ino) == (
                                stage_identity.st_dev,
                                stage_identity.st_ino,
                            ):
                                directory.unlink(temporary)
                        except FileNotFoundError:
                            pass
                finally:
                    if stage_descriptor is not None:
                        os.close(stage_descriptor)
                    if directory is not None:
                        directory.close()
        if notify:
            self._wrote(scope.project.id, path)
        else:
            self._events.suppress(scope.project.id, path)
        return ContentWriteReceipt(
            project_id=project_id or ProjectRegistry.CURRENT,
            path=path,
            size=size,
            revision=revision,
        )

    def delete_bytes(self, project_id: str, path: str, expected_revision: str) -> None:
        """CAS 删除供领域级回滚使用；用户主动删除仍走系统废纸篓。"""

        scope = self._space(project_id)
        target = self._file(project_id, path)
        lock = _file_lock(target)
        with lock:
            if _revision(target) != expected_revision:
                raise ContentError("revision_conflict")
            try:
                target.unlink()
            except OSError as exc:
                raise ContentError("delete_failed") from exc
        self._wrote(scope.project.id, path)

    def apply_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str | None,
        *,
        force: bool,
        mode_bits: int | None,
        notify: bool = True,
    ) -> ContentWriteReceipt:
        """Create or replace exact bytes after an explicit conflict decision."""

        scope = self._space(project_id)
        target = scope.absolute(path)
        if target.is_dir():
            raise ContentError("not_a_file")
        exists = target.is_file()
        observed = _revision(target) if exists else None
        if not force and observed != expected_revision:
            raise ContentError("revision_conflict")
        return self._replace_bytes(
            scope.project.id,
            path,
            content,
            None if force else expected_revision,
            None if exists else b"",
            mode_bits=mode_bits,
            notify=notify,
        )

    def apply_stream(
        self,
        project_id: str,
        path: str,
        content: BinaryIO,
        size: int,
        revision: str,
        expected_revision: str | None,
        *,
        force: bool,
        mode_bits: int | None,
        notify: bool = True,
    ) -> ContentWriteReceipt:
        """Create or replace exact streamed bytes after an explicit conflict decision."""

        scope = self._space(project_id)
        target = scope.absolute(path)
        if target.is_dir():
            raise ContentError("not_a_file")
        exists = target.is_file()
        observed = _revision(target) if exists else None
        if not force and observed != expected_revision:
            raise ContentError("revision_conflict")
        return self._replace_stream(
            scope.project.id,
            path,
            content,
            size,
            revision,
            None if force else expected_revision,
            None if exists else b"",
            mode_bits=mode_bits,
            notify=notify,
        )

    def remove_bytes(
        self,
        project_id: str,
        path: str,
        expected_revision: str | None,
        *,
        force: bool,
        notify: bool = True,
    ) -> None:
        """Remove an exact file after an explicit recovery conflict decision."""

        scope = self._space(project_id)
        target = scope.absolute(path)
        if target.exists() and not target.is_file():
            raise ContentError("not_a_file")
        lock = _file_lock(target)
        with lock:
            observed = _revision(target) if target.exists() else None
            if not force and observed != expected_revision:
                raise ContentError("revision_conflict")
            try:
                target.unlink(missing_ok=True)
            except OSError as exc:
                raise ContentError("write_failed") from exc
        if notify:
            self._wrote(scope.project.id, path)
        else:
            self._events.suppress(scope.project.id, path)

    # ---- 目录投影与搜索 ----

    def tree(
        self,
        project_id: str,
        root: RootKind = RootKind.RESOURCES,
        depth: int = tree.DEFAULT_MAX_DEPTH,
        offset: int = 0,
    ) -> AssetPage:
        scope = (
            self._resource_space(project_id)
            if root is RootKind.RESOURCES
            else self._rooted_space(project_id)
        )
        if root in OWNED_ROOT_KINDS and root not in scope.owned_roots:
            return AssetPage()
        location = resolve_root(scope.project, root)
        return tree.build_tree(scope, location.absolute, max_depth=depth, offset=offset)

    def subtree(
        self,
        project_id: str,
        path: str,
        depth: int,
        offset: int = 0,
        *,
        root: RootKind = RootKind.RESOURCES,
    ) -> AssetPage:
        """续扫某个目录的一页 (UI 展开更深层级、或要同一层下一页时用)。

        起点经 `absolute()` 解析, 越界校验与挂载解析都沿用同一处 —— 所以
        「关联目录内部第 N 层」不是特例, 和项目内目录走的是同一条路径。

        `depth` 不给默认值: 首屏与续扫要的深度本就不同, 且类体到这里
        `tree` 已经是上面那个方法名, 模块级默认值在这行取不到。
        """

        scope = (
            self._resource_space(project_id)
            if root is RootKind.RESOURCES
            else self._rooted_space(project_id)
        )
        if root in OWNED_ROOT_KINDS:
            registered = scope.owned_roots.get(root)
            if registered is None:
                return AssetPage()
            target = scope.absolute(path)
            base = scope.absolute(registered)
            if target != base and base not in target.parents:
                raise ContentError(roots.OWNED_ROOT_CONFLICT)
        return tree.build_tree(scope, scope.absolute(path), max_depth=depth, offset=offset)

    def repository_roots(self, project_id: str, paths: tuple[str, ...]) -> dict[str, str | None]:
        return repository.repository_roots(self._resource_space(project_id), paths)

    def enumerate_resources(self, project_id: str, cursor: str | None, limit: int) -> ResourcePage:
        """Complete background enumeration, separate from the paginated UI tree."""

        if limit < 1:
            raise ContentError("invalid_limit")
        return enumeration.enumerate_files(self._resource_space(project_id), cursor, limit)

    def scan_resources(
        self,
        project_id: str,
        observer: ResourceScanObserver | None = None,
    ) -> tuple[ResourceEntry, ...]:
        """Scan all resources once while exposing factual discovery events."""

        return enumeration.scan_files(self._resource_space(project_id), observer)

    def resource_entries(
        self, project_id: str, paths: tuple[str, ...]
    ) -> tuple[ResourceEntry, ...]:
        """Inspect selected resource files without recursively scanning the roots."""

        return enumeration.entries_for_paths(self._resource_space(project_id), paths)

    def root(self, project_id: str, root: RootKind) -> FileAssetRef:
        """按种类取根节点, 并保证该目录存在。

        就地创建而不是让调用方处理「根还不存在」: 两个根是**产品拥有**的位置
        (不是用户随手建的目录), 任何东西要落进去都得先有它。让每个域各自
        `mkdir` 正是本提案要消掉的第二处文件操作。
        """

        project = self._space(project_id).project
        location = resolve_root(project, root)
        if root in OWNED_ROOT_KINDS:
            scope = self._space(project.id)
            if scope.mount_for(location.relative) is not None:
                raise ContentError(roots.OWNED_ROOT_CONFLICT)
            roots.ensure_owned_root(self.resolve(project.id, PROJECT_DB_RELATIVE), location)
            return FileAssetRef(
                project_id=project.id,
                path=location.relative,
                name=location.absolute.name,
                kind=AssetKind.DIR,
            )
        try:
            # Never recursively recreate a project that disappeared after resolution.
            with directory(Path(project.root), tuple(Path(location.relative).parts), create=True):
                pass
        except OSError as exc:
            raise ContentError(ROOT_UNAVAILABLE_ERROR) from exc
        return FileAssetRef(
            project_id=project.id,
            path=location.relative,
            name=location.absolute.name,
            kind=AssetKind.DIR,
        )

    def within_root(self, project_id: str, root: RootKind, path: str) -> str:
        """Translate a root-relative path without leaking layout or allowing escape."""

        cleaned = space.normalize(path)
        if ".." in cleaned.split(space.SEPARATOR):
            raise ContentError(PATH_OUTSIDE_ROOT_ERROR)
        root_path = self.root(project_id, root).path
        if (
            root_path
            and cleaned != root_path
            and not cleaned.startswith(f"{root_path}{space.SEPARATOR}")
        ):
            cleaned = f"{root_path}{space.SEPARATOR}{cleaned}" if cleaned else root_path
        self._space(project_id).absolute(cleaned)
        return cleaned

    def ensure_directory(self, project_id: str, parent: str, name: str) -> FileAssetRef:
        scope = self._space(project_id)
        created = assets.ensure_folder(scope, parent, name)
        self._wrote(scope.project.id, created.path)
        return created

    def search(self, project_id: str, query: str) -> ResourceSearchResult:
        """Search current authorized resource files through stable Content reads."""

        scope = self._resource_space(project_id)
        location = resolve_root(scope.project, RootKind.RESOURCES)
        return search.search_resources(
            enumeration.scan_files(scope),
            query,
            lambda path, max_bytes: self.stable_snapshot(scope.project.id, path, max_bytes),
            resource_root=location.relative,
        )

    # ---- 资产 CRUD ----

    def create(
        self,
        project_id: str,
        parent: str,
        name: str,
        kind: AssetKind,
    ) -> FileAssetRef:
        scope = self._space(project_id)
        if kind is AssetKind.FILE:
            target = assets.document_target(scope, parent, name)
            return self.write_text(scope.project.id, scope.relative(target), "")
        created = assets.create_folder(scope, parent, name)
        self._wrote(scope.project.id, created.path)
        return created

    def create_text(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: str,
    ) -> FileAssetRef:
        """Choose one collision-free path and persist its complete initial text."""

        scope = self._space(project_id)
        target = assets.document_target(scope, parent, name)
        return self.write_text(scope.project.id, scope.relative(target), content)

    def destination(self, project_id: str, parent: str, name: str) -> FileAssetRef:
        """Choose a generic target through Content's confinement and naming rules."""

        scope = self._space(project_id)
        return assets.node_for(scope, assets.file_target(scope, parent, name))

    def rename(self, project_id: str, path: str, name: str) -> FileAssetRef:
        scope = self._space(project_id)
        source = scope.relative(scope.absolute(path))
        destination_path = assets.rename_target(scope, source, name)
        destination = scope.relative(destination_path)
        renamed = identity.relocate(
            scope,
            self.resolve(scope.project.id, PROJECT_DB_RELATIVE),
            source,
            destination,
            lambda: assets.rename_node(
                scope,
                source,
                name,
                destination=destination_path,
            ),
        )
        self._moved(scope.project.id, source, renamed.path)
        return renamed

    def move(self, project_id: str, path: str, target_dir: str) -> FileAssetRef:
        scope = self._space(project_id)
        source = scope.relative(scope.absolute(path))
        destination_path = assets.move_target(scope, source, target_dir)
        destination = scope.relative(destination_path)
        moved = identity.relocate(
            scope,
            self.resolve(scope.project.id, PROJECT_DB_RELATIVE),
            source,
            destination,
            lambda: assets.move_node(
                scope,
                source,
                target_dir,
                destination=destination_path,
            ),
        )
        self._moved(scope.project.id, source, moved.path)
        return moved

    def copy(self, project_id: str, path: str, target_dir: str | None) -> FileAssetRef:
        scope = self._space(project_id)
        copied = self._execute_copy(scope, assets.copy_plan(scope, path, target_dir), "copy_failed")
        self._wrote(scope.project.id, copied.path)
        return copied

    def import_sources(
        self,
        project_id: str,
        sources: tuple[str, ...],
        target_dir: str,
        mode: ImportMode,
        target_names: tuple[str, ...] | None = None,
        observer: ContentImportObserver | None = None,
        cancelled: ContentImportCancellation | None = None,
        collision_policy: ImportCollisionPolicy = ImportCollisionPolicy.RENAME,
        failure_policy: ImportFailurePolicy = ImportFailurePolicy.FAIL_FAST,
        result_observer: ContentImportResultObserver | None = None,
    ) -> tuple[FileAssetRef, ...]:
        scope = self._space(project_id)
        if mode is ImportMode.LINK:
            if target_names is not None:
                raise ContentError(assets.INVALID_IMPORT_TARGET_NAMES)
            return assets.linked_sources(scope, sources)
        discovered_items = 0

        def discovered(delta: int) -> None:
            nonlocal discovered_items
            if cancelled is not None and cancelled():
                raise ContentError(IMPORT_CANCELLED_ERROR)
            discovered_items += delta
            if observer is not None:
                observer(
                    ContentImportProgress(
                        ContentImportStage.SCANNING,
                        discovered_items,
                        0,
                        0,
                        0,
                    )
                )

        if observer is not None:
            observer(ContentImportProgress(ContentImportStage.SCANNING, 0, 0, 0, 0))
        plan_results = assets.import_plan_results(
            scope,
            sources,
            target_dir,
            target_names,
            collision_policy=collision_policy,
            discovered=discovered,
        )
        if any(result.error == IMPORT_CANCELLED_ERROR for result in plan_results):
            raise ContentError(IMPORT_CANCELLED_ERROR)
        if failure_policy is ImportFailurePolicy.FAIL_FAST:
            for result in plan_results:
                if result.plan is None:
                    raise ContentError(result.error)
        elif result_observer is not None:
            for result in plan_results:
                if result.plan is None:
                    result_observer(
                        ContentImportSourceResult(result.source_index, None, result.error)
                    )
        plans = tuple(result for result in plan_results if result.plan is not None)
        if observer is not None:
            observer(
                ContentImportProgress(
                    ContentImportStage.SCANNING,
                    discovered_items,
                    discovered_items,
                    0,
                    0,
                )
            )
        total_items = sum(len(result.plan.files) for result in plans if result.plan is not None)
        total_bytes = sum(
            member.source.stat().st_size
            for result in plans
            if result.plan is not None
            for member in result.plan.files
        )
        completed_items = 0
        completed_bytes = 0

        def report(delta_bytes: int, completed: bool) -> None:
            nonlocal completed_items, completed_bytes
            completed_bytes += delta_bytes
            completed_items += int(completed)
            if observer is not None:
                observer(
                    ContentImportProgress(
                        ContentImportStage.COPYING,
                        completed_items,
                        total_items,
                        completed_bytes,
                        total_bytes,
                    )
                )

        imported_items: list[FileAssetRef] = []
        import_scope = (
            self._resource_changes.import_scope(project_id)
            if self._resource_changes is not None
            else nullcontext()
        )
        with import_scope:
            for result in plans:
                if result.plan is None:  # narrowed above; retained for static type checking
                    continue
                try:
                    imported_item = self._execute_copy(
                        scope,
                        result.plan,
                        "import_failed",
                        progress=report,
                        cancelled=cancelled,
                    )
                except ContentError as error:
                    if (
                        error.code == IMPORT_CANCELLED_ERROR
                        or failure_policy is ImportFailurePolicy.FAIL_FAST
                    ):
                        raise
                    if result_observer is not None:
                        result_observer(
                            ContentImportSourceResult(result.source_index, None, error.code)
                        )
                    continue
                imported_items.append(imported_item)
                if result_observer is not None:
                    result_observer(
                        ContentImportSourceResult(result.source_index, imported_item, "")
                    )
        imported = tuple(imported_items)
        self._wrote(scope.project.id, *(item.path for item in imported))
        return imported

    def _execute_copy(
        self,
        scope: space.ProjectSpace,
        plan: assets.CopyPlan,
        error_code: str,
        *,
        progress: Callable[[int, bool], None] | None = None,
        cancelled: ContentImportCancellation | None = None,
    ) -> FileAssetRef:
        """Execute a copy plan with a durable version boundary per eligible file."""

        try:
            for member in plan.directories:
                member.target.mkdir(parents=False)
            for member in plan.files:
                if cancelled is not None and cancelled():
                    raise ContentError(IMPORT_CANCELLED_ERROR)
                source_stat = member.source.stat()
                target_path = scope.relative(member.target)
                if source_stat.st_size > MAX_BYTES:
                    try:
                        with (
                            member.source.open("rb") as source_stream,
                            member.target.open("xb") as target_stream,
                        ):
                            while chunk := source_stream.read(IMPORT_COPY_CHUNK_BYTES):
                                if cancelled is not None and cancelled():
                                    raise ContentError(IMPORT_CANCELLED_ERROR)
                                target_stream.write(chunk)
                                if progress is not None:
                                    progress(len(chunk), False)
                        shutil.copystat(member.source, member.target)
                    except Exception:
                        member.target.unlink(missing_ok=True)
                        raise
                    if progress is not None:
                        progress(0, True)
                    self._wrote(scope.project.id, target_path)
                    continue
                payload, mode_bits = _stable_source(member.source)
                receipt = None
                if self._resource_changes is not None:
                    receipt = self._resource_changes.commit_product_bytes(
                        scope.project.id,
                        target_path,
                        payload,
                        ProductMutationKind.CREATE,
                        f"{PRODUCT_MUTATION_KEY_PREFIX}:{uuid4().hex}",
                        mode_bits=mode_bits,
                    )
                if receipt is None:
                    self.apply_bytes(
                        scope.project.id,
                        target_path,
                        payload,
                        None,
                        force=False,
                        mode_bits=mode_bits,
                    )
                if progress is not None:
                    progress(source_stat.st_size, True)
            for member in reversed(plan.directories):
                shutil.copystat(member.source, member.target)
        except ContentError:
            raise
        except FileExistsError as exc:
            raise ContentError(assets.NAME_EXISTS) from exc
        except OSError as exc:
            raise ContentError(DISK_FULL_ERROR if exc.errno == ENOSPC else error_code) from exc
        return assets.node_for(scope, plan.root)

    # ---- 项目身份 ----

    def project(self, project_id: str | None = None) -> ProjectRef:
        """单个项目引用。供 api 层回报根路径与项目名。"""

        return self._registry.resolve(project_id)

    def projects(self) -> tuple[ProjectRef, ...]:
        return self._registry.projects()

    def create_project(self, name: str) -> ProjectRef:
        return self._registry.create(name)

    def adopt_project(self, path: str, name: str = "") -> ProjectRef:
        return self._registry.adopt(Path(path), name)

    def forget_project(self, project_id: str) -> None:
        self._registry.forget(project_id)
        self._events.forget(project_id)
        if self._project_forget_sink is not None:
            self._project_forget_sink(project_id)

    def rename_project(self, project_id: str, name: str) -> ProjectRef:
        return self._registry.rename(project_id, name)

    def set_project_archived(self, project_id: str, archived: bool) -> ProjectRef:
        return self._registry.set_archived(project_id, archived)

    def project_for_path(self, absolute: str) -> ProjectRef | None:
        return self._registry.for_path(absolute)

    def project_relative(self, project_id: str, absolute: str) -> str:
        """Resolve an absolute path through the authoritative project path space."""

        return self._space(project_id).relative(Path(absolute).expanduser().resolve())

    # ---- 关联外部根与授权 ----

    def authorize_root(
        self, project_id: str, source: str, mount: str, *, supersede: bool = False
    ) -> ExternalRootRef:
        return self._roots.authorize(
            self._registry.resolve(project_id), source, mount, supersede=supersede
        )

    def authorize_root_at(
        self, project_id: str, source: str, parent: str, name: str
    ) -> ExternalRootRef:
        """Register a single source at a validated local resource directory."""

        scope = self._space(project_id)
        parent = self.within_root(project_id, RootKind.RESOURCES, parent)
        requested = space.SEPARATOR.join(
            part for part in (parent, assets.validate_name(name)) if part
        )
        for existing in self.external_roots(project_id):
            if existing.mount_path == requested:
                if existing.source_path == str(Path(source).expanduser().resolve()):
                    return existing
                raise ContentError("mount_conflict")
        candidate = self.destination(project_id, parent, name)
        if candidate.path != requested:
            raise ContentError("mount_conflict")
        if any(
            parent == root.mount_path or parent.startswith(f"{root.mount_path}/")
            for root in self.external_roots(project_id)
        ):
            raise ContentError("invalid_mount")
        root = self.root(project_id, RootKind.RESOURCES).path
        mount = requested[len(root) + 1 :] if root else requested
        directory = scope.open_directory(parent)
        try:
            for existing in self.external_roots(project_id):
                if existing.mount_path == requested:
                    if existing.source_path == str(Path(source).expanduser().resolve()):
                        return existing
                    raise ContentError("mount_conflict")
            return self._roots.authorize(scope.project, source, mount, nested=True)
        finally:
            directory.close()

    def authorize_roots(
        self, project_id: str, sources: tuple[str, ...], mounts: tuple[str, ...]
    ) -> tuple[ExternalRootRef, ...]:
        return self._roots.authorize_many(self._registry.resolve(project_id), sources, mounts)

    def authorize_import_roots(
        self, project_id: str, sources: tuple[str, ...], target_dir: str
    ) -> tuple[ExternalRootRef, ...]:
        """Authorize selected sources at collision-free names inside one local directory."""

        scope = self._space(project_id)
        target_dir = self.within_root(scope.project.id, RootKind.RESOURCES, target_dir)
        if scope.mount_for(target_dir) is not None:
            raise ContentError("invalid_mount")
        targets = assets.import_target_paths(
            scope,
            target_dir,
            tuple(Path(source).expanduser().name for source in sources),
        )
        resource_root = resolve_root(scope.project, RootKind.RESOURCES).relative
        prefix = f"{resource_root}/" if resource_root else ""
        mounts = tuple(scope.relative(target)[len(prefix) :] for target in targets)
        return self._roots.authorize_many(scope.project, sources, mounts, nested=True)

    def assert_import_roots_linkable(self, project_id: str, sources: tuple[str, ...]) -> None:
        """关联导入创建任务前的只读包含预检; 权威复检仍在 job 执行 `authorize_import_roots` 时。"""

        self._roots.assert_linkable(self._registry.resolve(project_id), sources)

    def revoke_root(self, root_id: str) -> None:
        self._roots.revoke(root_id)

    def external_roots(self, project_id: str) -> tuple[ExternalRootRef, ...]:
        return self._roots.active(self._registry.resolve(project_id).id)

    def writable_roots(self, project_id: str) -> tuple[str, ...]:
        return self._roots.writable_roots(self._registry.resolve(project_id))

    # ---- 删除接缝 ----

    def issue_trash_token(self, project_id: str, path: str) -> str:
        scope = self._space(project_id)
        absolute = assets.resolve_for_delete(scope, path)
        return self._tokens.issue(scope.project.id, str(absolute))

    def redeem_trash_token(self, trash_token: str) -> str:
        """Redeem a path for the host process without claiming deletion succeeded."""

        return self._tokens.redeem(trash_token).absolute

    def complete_trash_token(self, trash_token: str) -> str:
        """Record and publish a deletion only after the OS trash operation succeeds."""

        grant = self._tokens.completion_grant(trash_token)
        target = Path(grant.absolute)
        if target.exists():
            raise ContentError("trash_not_completed")
        grant, fresh = self._tokens.complete(trash_token)
        relative = self._space(grant.project_id).relative(target)
        if fresh:
            self._catalog.record(AUDIT_TRASH, grant.absolute, grant.project_id)
            self._wrote(grant.project_id, relative)
        return relative

    def trash_history(self, project_id: str, limit: int = 50) -> tuple[Any, ...]:
        """该项目最近的删除记录 (供产品内的恢复入口展示原位置)。"""

        return tuple(
            row
            for row in self._catalog.audit(limit * 4)
            if str(row["action"]) == AUDIT_TRASH and str(row["project_id"] or "") == project_id
        )[:limit]


__all__ = [
    "DEFAULT_MEDIA_TYPE",
    "DIGEST_CHUNK_BYTES",
    "MAX_BYTES",
    "MAX_TEXT_BYTES",
    "REVISION_PREFIX",
    "STABLE_READ_ATTEMPTS",
    "ContentService",
    "ProjectRegistry",
]
