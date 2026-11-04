"""项目与资产的公共契约 (开发 1 拥有)。

架构文档 §2.2 将本文件定为 `service.content` 对外的唯一窗口:
资料库 / 文献库 / 文档 / Workbench / Assistant 均**只能**经 `ContentPort`
访问文件与路径, 不得自行拼接根路径或再建第二套文件 Store。

为什么只放协议而不放实现: 本文件是跨域共享的热点文件。若在此处写实现,
六个域会因一个行为变更而同时冲突; 只留 Protocol + 不可变记录时,
实现换了也不影响调用方的编译期契约。

本文件零业务逻辑: 仅 Protocol + frozen dataclass + Enum。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import AsyncIterator, BinaryIO, Callable, Protocol, runtime_checkable

IMPORT_CANCELLED_ERROR = "import_cancelled"
DISK_FULL_ERROR = "disk_full"


class ArtifactSnapshotFailure(str, Enum):
    BUSY = "artifact_snapshot_busy"
    ACCESS_DENIED = "artifact_snapshot_access_denied"
    UNSUPPORTED = "artifact_snapshot_unsupported"
    DISK_FULL = "artifact_snapshot_disk_full"
    UNAVAILABLE = "artifact_snapshot_unavailable"


#: 导入时的处理方式 (PRD「资料导入」的复制 / 关联双卡片)。
class ImportMode(str, Enum):
    """COPY 在项目空间内落一份副本; LINK 不搬移原文件。"""

    COPY = "copy"
    LINK = "link"


class ImportFailurePolicy(str, Enum):
    FAIL_FAST = "fail_fast"
    CONTINUE = "continue"


class ImportCollisionPolicy(str, Enum):
    """Whether COPY may choose another name when its requested target is occupied."""

    RENAME = "rename"
    EXACT = "exact"


class ContentImportStage(str, Enum):
    SCANNING = "scanning"
    COPYING = "copying"


@dataclass(frozen=True)
class ContentImportProgress:
    stage: ContentImportStage
    completed_items: int
    total_items: int
    completed_bytes: int
    total_bytes: int


ContentImportObserver = Callable[[ContentImportProgress], None]
ContentImportCancellation = Callable[[], bool]


class AssetKind(str, Enum):
    """资产种类。目录与文件是文件系统层面的区分, 不携带业务含义。"""

    FILE = "file"
    DIR = "dir"


class ResourceMatch(str, Enum):
    """The strongest field responsible for a resource search hit."""

    NAME = "name"
    PATH = "path"
    CONTENT = "content"


class ResourceRevealKind(str, Enum):
    """Viewer-neutral navigation carried by a resource search hit."""

    FIND = "find"


class FileEventKind(str, Enum):
    """根目录监听产生的事件类型 (架构文档 §4.1 文件系统变化链路)。

    `RESCAN` 不是文件事件, 是一条「你手上的增量已经不可信, 请整棵树重取」的
    指令: 游标世代不匹配、监听器掉线、单次变更超过归并上限时发它。没有这条,
    客户端只能在丢事件与静默错位之间选一个。
    """

    CREATED = "created"
    MODIFIED = "modified"
    DELETED = "deleted"
    MOVED = "moved"
    RESCAN = "rescan"


class EventSource(str, Enum):
    """这条变更是产品自己写的, 还是用户在访达/其他程序里改的。

    产品自写的变更前端本来就知道 (它刚发起的那次操作), 标出来才能不做二次刷新
    ——否则「保存 → 事件 → 刷新 → 再保存」会自己转起来。
    """

    PRODUCT = "product"
    EXTERNAL = "external"


@dataclass(frozen=True)
class ImportSourceContent:
    """Bytes read for an explicit user import, not a persistent path capability."""

    name: str
    content: bytes
    media_type: str


@dataclass(frozen=True)
class ImportSourcePlan:
    """Content-owned preflight for one explicitly selected local COPY source."""

    source_index: int
    source_name: str
    source_kind: AssetKind
    source_generation: str
    source_revision: str | None
    source_size: int
    source_mode_bits: int
    requested_path: str
    target_path: str
    conflict: bool
    target_kind: AssetKind | None = None
    target_revision: str | None = None
    target_size: int | None = None


@dataclass(frozen=True)
class ContentSnapshot:
    """一次文件内容观察；revision 对 exact bytes 负责。"""

    project_id: str
    path: str
    media_type: str
    size: int
    revision: str
    writable: bool


@dataclass(frozen=True)
class ContentWriteReceipt:
    """CAS 保存成功后的新内容身份。"""

    project_id: str
    path: str
    size: int
    revision: str


@dataclass(frozen=True)
class StableContentSnapshot:
    """Bytes and metadata proven unchanged across one bounded read."""

    project_id: str
    path: str
    media_type: str
    content: bytes
    revision: str
    mtime_ns: int
    mode_bits: int

    @property
    def size(self) -> int:
        return len(self.content)


@dataclass(frozen=True)
class StableContentCapture:
    """Metadata for exact bytes copied into a caller-owned seekable stream."""

    project_id: str
    path: str
    media_type: str
    size: int
    revision: str
    mtime_ns: int
    mode_bits: int


@dataclass(frozen=True)
class ResourceEntry:
    """One file from the complete background resource enumeration."""

    path: str
    size: int
    created_at: float = 0.0


ResourceScanObserver = Callable[[ResourceEntry], None]


@dataclass(frozen=True)
class ResourcePage:
    """A deterministic cursor page independent of the UI tree depth limit."""

    entries: tuple[ResourceEntry, ...]
    next_cursor: str | None = None


@dataclass(frozen=True)
class PreparedContent:
    """Owner-persisted creation receipt; not accepted as a client capability.

    The staging inode remains linked until the owner commits its durable result.
    Only Content interprets the relative paths or accesses the filesystem.
    """

    project_id: str
    path: str
    staging_path: str
    device: int
    inode: int
    size: int
    sha256: str
    marker: str


class ArtifactScopeKind(str, Enum):
    PROJECT = "project"
    SESSION = "session"


@dataclass(frozen=True)
class ArtifactScope:
    kind: ArtifactScopeKind
    id: str


@dataclass(frozen=True)
class ArtifactStorageLocation:
    """Trusted owner configuration, never accepted from a renderer/model request."""

    source_root: str
    storage_root: str
    objects_relative: str
    database: str


@dataclass(frozen=True)
class VerifiedArtifactContent:
    """Immutable artifact bytes; original filename survives hash-addressed storage.

    This is an internal content handle, not authority to access a user's project.
    Product callers must authorize the session and publication before using it.
    """

    scope: ArtifactScope
    source_path: str
    name: str
    media_type: str
    size: int
    sha256: str


class RootKind(str, Enum):
    """项目内容根的用途；产物根须显式登记，不能认领已有用户目录。"""

    RESOURCES = "resources"
    LITERATURE = "literature"
    ARTIFACTS = "artifacts"
    SESSIONS = "sessions"


TREE_DEFAULT_DEPTH = 3


class ProjectLayout(str, Enum):
    """项目目录布局。

    MANAGED 是内置根形态 (`<项目>/{资料库,文献库}`), 由产品新建;
    LEGACY 是 0.2 之前「选一个本地文件夹即项目」的存量形态, 资料铺在项目根下。
    两者必须共存: 存量项目若按 MANAGED 解析, 资料树会立刻空掉。
    """

    MANAGED = "managed"
    LEGACY = "legacy"


class AssetOrigin(str, Enum):
    """资产是项目内的本地文件, 还是关联进来的项目外文件。

    LINK 节点的物理位置在项目外, 改名/同根移动作用于原始文件，删除只允许
    撤销关联并保留原文件。因此 UI 必须能区分二者。
    """

    LOCAL = "local"
    LINK = "link"


@dataclass(frozen=True)
class ProjectRef:
    """项目身份。`id` 是稳定标识, 跳域传递时用它而不传绝对路径。"""

    id: str
    #: 显示名。可改, 与目录名无关。
    name: str
    #: 项目根绝对路径。仅 content 域自己与需要调用原生能力的层使用。
    root: str
    layout: ProjectLayout = ProjectLayout.LEGACY
    #: 目录当前是否可访问 (外部盘拔出、目录被删、权限丢失时为 False)。
    #: 没有这个字段, UI 无法区分「项目失效」与「空项目」。
    available: bool = True
    #: 登记时间 (秒)。库行一定有值; None 只出现在未落库的直接构造里。
    created_at: float | None = None
    #: 归档时间 (秒)。非空即已归档: 默认列表不显示, 但身份与路径解析不受影响。
    archived_at: float | None = None
    #: 本次运行内项目不可用的诊断原因；不改变持久化登记。
    unavailable_reason: str | None = None
    description: str = ""
    pinned: bool = False
    directory_created_at: float | None = None


@dataclass(frozen=True)
class FileAssetRef:
    """一份资产的稳定引用。

    `path` 是**相对项目根**的 posix 路径, 作为跳域唯一标识。
    不暴露绝对路径: 架构文档 §2.3 要求「AI 面板只提交稳定 ID 与结构化上下文,
    不提交任意绝对路径」。关联资产同样用相对路径 —— 外部根登记为项目内的
    虚拟挂载点, 因此单一相对基仍然成立。
    """

    project_id: str
    path: str
    name: str
    kind: AssetKind
    origin: AssetOrigin = AssetOrigin.LOCAL
    #: Present only after Content has durably registered this asset's identity.
    asset_id: str | None = None


@dataclass(frozen=True)
class ContentImportSourceResult:
    source_index: int
    imported: FileAssetRef | None
    error: str


ContentImportResultObserver = Callable[[ContentImportSourceResult], None]


class AssetState(str, Enum):
    """Whether a stable content identity can currently resolve its source bytes."""

    AVAILABLE = "available"
    MISSING = "missing"
    AUTHORIZATION_REQUIRED = "authorization_required"
    CONFLICT = "conflict"


@dataclass(frozen=True)
class AssetBinding:
    """Stable application identity plus its mutable, possibly unavailable locator."""

    asset: FileAssetRef
    state: AssetState
    revision: str | None = None


@dataclass(frozen=True)
class ExternalRootRef:
    """一处被授权的项目外文件或目录。

    `source_path` 是外部真实绝对路径, 只有 content 域与需要调原生能力的层
    (主进程废纸篓、访达、Agent 沙箱) 使用; 产品其余部分一律用 `mount_path`。
    """

    root_id: str
    project_id: str
    #: 相对项目根的挂载点。
    mount_path: str
    #: 外部真实绝对路径。
    source_path: str
    #: 来源在授权时的文件系统种类。来源暂时失效时仍靠它稳定投影节点形状。
    kind: AssetKind
    authorized_at: float
    available: bool = True


@dataclass(frozen=True)
class ResourceReveal:
    """Find the literal query again in the document version opened by the viewer.

    `source_revision` identifies the stable bytes that produced the search hit.  It
    is evidence for stale-hit handling, never a coordinate to apply to newer bytes.
    """

    kind: ResourceRevealKind
    query: str
    source_revision: str


@dataclass(frozen=True)
class ResourceHit:
    """一条资料命中 (跨域返回类型, 故与 Port 同处一个文件)。"""

    path: str
    name: str
    #: 文件名、资料库内相对路径或正文中的最高优先级命中。
    matched: ResourceMatch
    #: 正文命中时的上下文片段; 文件名与路径命中为空串。
    snippet: str = ""
    #: 正文命中才携带；文件名和路径命中只打开文件。
    reveal: ResourceReveal | None = None


@dataclass(frozen=True)
class ResourceSearchResult:
    """资料搜索结果。

    `truncated` 为真表示遍历被命中上限截断, 磁盘上可能还有更多匹配 —— 它**不是**
    精确总数信号。聚合层据此把分组计数显示成「N+」, 而不是把上限当成真实命中数。
    """

    hits: tuple[ResourceHit, ...]
    truncated: bool = False


@dataclass(frozen=True)
class FileEvent:
    """根目录变更事件。由 content 域归并后广播, 资料库/文献库据此刷新。

    `epoch` + `seq` 是断线续传的全部依据: `seq` 在一个 epoch 内单调递增,
    `epoch` 变了说明服务端重启或游标重置, 客户端手上的 `seq` 不再可比 ——
    这时必须 RESCAN 而不是接着往后读, 否则是**静默**错位 (比丢事件更糟)。
    """

    epoch: str
    seq: int
    project_id: str
    root: RootKind
    kind: FileEventKind
    path: str
    source: EventSource = EventSource.EXTERNAL
    #: MOVED 事件的原路径; 其余类型为 None。
    previous_path: str | None = None


@dataclass(frozen=True)
class AssetTree:
    """一层目录的投影。`children` 是**本页**已投影的子节点, 不一定是全部。"""

    asset: FileAssetRef
    children: tuple["AssetTree", ...] = field(default_factory=tuple)
    #: 该节点当前可访问。关联根拔盘/被删时为 False —— 没有这个字段,
    #: UI 无法区分「关联失效」与「空目录」。
    available: bool = True
    #: 挂载点位置同时存在真实同名目录。以登记的挂载为准, 但必须让 UI 明示,
    #: 否则用户会以为自己的真实目录消失了。
    conflict: bool = False
    #: 该目录下可见条目的**总数**; None = 没数过 (文件节点, 或不曾扫这一层)。
    #:
    #: 与 `len(children)` 合起来是唯一判据: 少于总数就说明还有没投影出来的条目 ——
    #: 不管是深度上限没往下扫 (children 为空), 还是单层分页只取了前若干条。
    #: 两种截断都必须让 UI 看见, 否则用户看到的就是文件凭空消失; 而用同一个总数
    #: 表达它们, 就不会出现「两个字段各说一半」的第二处真相。
    child_total: int | None = None
    updated_at: float | None = None


@dataclass(frozen=True)
class AssetPage:
    """一层目录的一页子节点投影。

    单层可以有上万条 (node_modules 之类), 一次全投影会拖垮渲染, 所以按页取。
    `total` 让消费方知道还剩多少, `offset` 让它能接着往后要 —— 只回一页却不给
    总数, 就等于静默丢弃。
    """

    children: tuple[AssetTree, ...] = field(default_factory=tuple)
    #: 该层可见条目总数 (含本页没返回的)。
    total: int = 0
    #: 本页起点。
    offset: int = 0


@runtime_checkable
class ContentPort(Protocol):
    """content 域对外的窄 Port (开发 1 实现, 开发 2/3/4/5/6 消费)。

    只放跳域真正需要的能力。域内细节 (监听器调度、事件归并策略、
    授权缓存) 不进本接口 —— 否则上层会开始依赖这些细节, Port 就失去隔离作用。
    """

    def root_relative(self, project_id: str, root: RootKind) -> str:
        """Return the project-relative root path without creating directories."""
        ...

    def project_relative(self, project_id: str, absolute: str) -> str:
        """Resolve an absolute source against the registered project and mounts."""
        ...

    def resolve(self, project_id: str, path: str) -> str:
        """相对路径 → 经越界校验的绝对路径。越界则拒绝。"""
        ...

    def repository_roots(self, project_id: str, paths: tuple[str, ...]) -> dict[str, str | None]:
        """Nearest Git roots within the resource/mount grant, including missing files."""
        ...

    def locate(self, project_id: str, root: RootKind, absolute_path: str) -> FileAssetRef | None:
        """绝对路径属于指定业务根时，返回项目相对身份。"""
        ...

    def exists(self, project_id: str, path: str) -> bool:
        """项目内该路径是否已存在 (含挂载内部); 越界视为不存在。

        存在性必须能单独问, 不能靠「在树里找得到」来推断: 树是分页的, 那一层
        一旦超过一页, 没在本页出现的目录就会被当成不存在 —— 于是「确保目录存在」
        的调用方会重复新建, 落成 `ai_extracts (2)` 这种避让名。
        """
        ...

    def is_directory(self, project_id: str, path: str) -> bool:
        """项目内该路径是否为当前可访问的目录; 越界或失效时返回 False。"""
        ...

    def read_text(self, project_id: str, path: str) -> str:
        """读文本资产。"""
        ...

    def write_text(self, project_id: str, path: str, content: str) -> FileAssetRef:
        """原子写入文本资产 (回答存入资料库、编辑器保存均经此)。"""
        ...

    def create_text(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: str,
    ) -> FileAssetRef:
        """以不覆盖同名文件的方式创建完整文本资产。"""
        ...

    def read_asset_bytes(
        self, project_id: str, asset_id: str, max_bytes: int = ...
    ) -> tuple[bytes, str]:
        """Read a registered physical file by stable identity, refusing path substitution."""
        ...

    def identify(self, project_id: str, path: str) -> AssetBinding:
        """Register or resolve an existing file without modifying its source bytes."""
        ...

    def asset_status(self, project_id: str, asset_id: str) -> AssetBinding:
        """Return a stable identity even while its source locator is unavailable."""
        ...

    def rebind_asset(self, project_id: str, source: str, destination: str) -> AssetBinding | None:
        """Adopt a verified move already performed outside Content's mutation path."""
        ...

    def read_bytes(self, project_id: str, path: str, max_bytes: int = ...) -> tuple[bytes, str]:
        """读字节与 MIME (PDF / 图片预览经此)。"""
        ...

    def read_import_source(self, project_id: str, source: str) -> ImportSourceContent:
        """Read an explicitly selected file for an authenticated product import.

        This grants no mount, writable root or arbitrary agent file access.
        """
        ...

    def plan_import_sources(
        self, project_id: str, sources: tuple[str, ...], target_dir: str
    ) -> tuple[ImportSourcePlan, ...]:
        """Preflight COPY names and source/target generations without writing."""
        ...

    def create_bytes(self, project_id: str, parent: str, name: str, content: bytes) -> FileAssetRef:
        """Create complete bytes without replacing an existing user file."""
        ...

    def prepare_bytes(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        reserved_paths: tuple[str, ...] = (),
    ) -> PreparedContent:
        """Stage bytes for an owner-persisted, recoverable exclusive creation."""
        ...

    def validate_prepared(self, prepared: PreparedContent) -> None:
        """Validate a persisted creation receipt without materializing it."""
        ...

    def publish_prepared(self, prepared: PreparedContent) -> FileAssetRef:
        """Publish or verify a previously published staging inode."""
        ...

    def prepared_asset(self, prepared: PreparedContent) -> FileAssetRef:
        """Find a completed creation without restoring missing user data."""
        ...

    def materialize(self, prepared: PreparedContent) -> FileAssetRef:
        """Commit a recoverable creation and return its Content-owned asset id."""
        ...

    def asset(
        self, project_id: str, asset_id: str, *, creation: PreparedContent | None = None
    ) -> FileAssetRef:
        """Resolve a verified identity, optionally requiring its original creation receipt."""
        ...

    def release_prepared(self, prepared: PreparedContent) -> None:
        """Release a staging link after the owner durably records success."""
        ...

    def read_optional_bytes(self, project_id: str, path: str, default: bytes) -> bytes:
        """读取可选的产品辅助文件；不存在时返回调用方定义的规范默认值。"""
        ...

    def files(self, project_id: str) -> tuple[FileAssetRef, ...]:
        """递归列出项目根内的普通文件，返回稳定相对路径。"""
        ...

    def revision(self, content: bytes) -> str:
        """计算与 CAS 写接口一致的完整内容 revision。"""
        ...

    def snapshot(self, project_id: str, path: str) -> ContentSnapshot:
        """读取文件元数据与 exact-bytes revision。"""
        ...

    def stable_snapshot(self, project_id: str, path: str, max_bytes: int) -> StableContentSnapshot:
        """Read bytes once and reject a source that changes during the read."""
        ...

    def capture_stable(
        self,
        project_id: str,
        path: str,
        max_bytes: int,
        target: BinaryIO,
    ) -> StableContentCapture:
        """Copy one stable generation into a caller-owned seekable stream."""
        ...

    def publish_working_bytes(self, scope: ArtifactScope, path: str, content: bytes) -> bool:
        """Create an exact working file; return True only for identical existing bytes.

        The caller authorizes the scope; its registered owner supplies the source root.
        """
        ...

    def capture_artifact(
        self, scope: ArtifactScope, path: str, expected_sha256: str = ""
    ) -> VerifiedArtifactContent:
        """Capture stable project-local bytes without overwriting an existing object."""
        ...

    def artifact_storage(self, scope: ArtifactScope) -> ArtifactStorageLocation:
        """Resolve a trusted project/session storage owner; empty identities fail."""
        ...

    def read_artifact(self, content: VerifiedArtifactContent) -> bytes:
        """Read and verify immutable bytes; never fall back to the working file."""
        ...

    def remove_artifact(self, content: VerifiedArtifactContent) -> None:
        """Remove an immutable snapshot only after its publication owner excludes other references."""
        ...

    def read_range(self, project_id: str, path: str, start: int, end: int) -> bytes:
        """读取闭区间 ``[start, end]`` 的文件字节。"""
        ...

    def commit_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
    ) -> ContentWriteReceipt:
        """仅当当前 revision 匹配时原子提交完整文件字节。"""
        ...

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
        """Create or replace exact bytes with an optional revision precondition."""
        ...

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
        """Create or replace an exact stream with an optional revision precondition."""
        ...

    def remove_bytes(
        self,
        project_id: str,
        path: str,
        expected_revision: str | None,
        *,
        force: bool,
        notify: bool = True,
    ) -> None:
        """Remove one exact file with an optional revision precondition."""
        ...

    def commit_optional_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
        default: bytes,
    ) -> ContentWriteReceipt:
        """以默认字节作为“不存在”版本，CAS 新建或替换产品辅助文件。"""
        ...

    def delete_bytes(self, project_id: str, path: str, expected_revision: str) -> None:
        """仅当当前 revision 匹配时永久删除一份普通文件。"""
        ...

    def tree(self, project_id: str, root: RootKind, depth: int, offset: int) -> AssetPage:
        """按根扫目录投影的一页。"""
        ...

    def subtree(
        self,
        project_id: str,
        path: str,
        depth: int,
        offset: int,
        *,
        root: RootKind = RootKind.RESOURCES,
    ) -> AssetPage:
        """从项目内某个目录接着往下扫, 回它子节点的一页。

        `tree` 只能从根起扫且有深度与单层上限, UI 展开更深层级或要下一页时必须能
        续扫, 否则那些上限就等于「用户永远看不到的条目」。路径同样相对项目根,
        因此挂载点内部 (关联进来的项目外目录) 也走同一条路径, 越界仍然拒绝。
        """
        ...

    def enumerate_resources(self, project_id: str, cursor: str | None, limit: int) -> ResourcePage:
        """Enumerate every file in resource and linked roots with a stable cursor."""
        ...

    def scan_resources(
        self,
        project_id: str,
        observer: ResourceScanObserver | None = None,
        *,
        paths: tuple[str, ...] | None = None,
    ) -> tuple[ResourceEntry, ...]:
        """Scan every resource once and report each newly discovered logical file."""
        ...

    def resource_entries(
        self, project_id: str, paths: tuple[str, ...]
    ) -> tuple[ResourceEntry, ...]:
        """Inspect the requested resource files without recursively scanning the roots."""
        ...

    def root_path(self, project_id: str, root: RootKind) -> str:
        """Return the logical root path without creating its directory."""
        raise NotImplementedError

    def root(self, project_id: str, root: RootKind) -> FileAssetRef:
        """按种类取根节点本身 (相对项目根的位置)。

        没有它, 上层要往「文献库根」里导入文件就必须自己知道那个目录叫什么,
        于是 `(layout, RootKind) → 相对位置` 这张表会在域外被复制一份;
        布局一变 (LEGACY 的 `文献` vs MANAGED 的 `literature`) 就有域落错目录。
        返回的是相对路径, 不泄露绝对路径。
        """
        ...

    def within_root(self, project_id: str, root: RootKind, path: str) -> str:
        """Map one root-relative path to the single project-relative path contract."""
        ...

    def ensure_directory(self, project_id: str, parent: str, name: str) -> FileAssetRef:
        """Create/reuse an exact directory; never rename it to avoid a conflict."""
        ...

    def create(self, project_id: str, parent: str, name: str, kind: AssetKind) -> FileAssetRef:
        """新建文件或目录, 同名自动避让不覆盖。"""
        ...

    def destination(self, project_id: str, parent: str, name: str) -> FileAssetRef:
        """Choose a collision-free generic file target without writing it."""
        ...

    def rename(self, project_id: str, path: str, name: str) -> FileAssetRef:
        """重命名。"""
        ...

    def move(self, project_id: str, path: str, target_dir: str) -> FileAssetRef:
        """移动。"""
        ...

    def relocate_file(
        self,
        project_id: str,
        path: str,
        target: str,
        expected_revision: str,
        *,
        notify: bool = True,
    ) -> FileAssetRef:
        """Move the same file to an exact unoccupied path after checking its revision."""
        ...

    def copy(self, project_id: str, path: str, target_dir: str | None) -> FileAssetRef:
        """复制。target_dir 为 None 时原地生成副本。"""
        ...

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
        """导入本机文件/目录；COPY 支持碰撞策略、真实进度、逐来源结果与协作取消。"""
        ...

    # ---- 项目身份 ----

    def project(self, project_id: str | None = None) -> ProjectRef:
        """单个项目引用。None 取当前默认项目 (工作区根对应的那个)。"""
        ...

    def projects(self) -> tuple[ProjectRef, ...]:
        """已登记的全部项目。"""
        ...

    def create_project(self, name: str) -> ProjectRef:
        """新建项目。只需显示名: 目录名与身份都由 content 生成。"""
        ...

    def adopt_project(self, path: str, name: str = "") -> ProjectRef:
        """把一个已存在的本地目录登记成 LEGACY 项目 (「添加已有文件夹」)。"""
        ...

    def rename_project(
        self,
        project_id: str,
        name: str,
        *,
        description: str | None = None,
        pinned: bool | None = None,
    ) -> ProjectRef:
        """改显示名。目录、已开会话、关联登记一律不动。"""
        ...

    def set_project_archived(self, project_id: str, archived: bool) -> ProjectRef:
        """归档/解归档项目。只影响默认列表可见性, 目录与会话数据一律不动。"""
        ...

    def forget_project(self, project_id: str) -> None:
        """把项目从书深移除。只摘登记, **不删**磁盘上的资料。"""
        ...

    def project_for_path(self, absolute: str) -> ProjectRef | None:
        """绝对路径 → 所属项目。会话记录仍存绝对路径, 靠这里解析回身份。"""
        ...

    def search(self, project_id: str, query: str) -> ResourceSearchResult:
        """资料库内按文件名、相对路径与正文搜索。截断与否随结果一并回报。"""
        ...

    # ---- 关联外部根与授权 ----

    def authorize_root(
        self, project_id: str, source: str, mount: str, *, supersede: bool = False
    ) -> ExternalRootRef:
        """授权一处项目外文件或目录, 并登记为项目内虚拟挂载点。"""
        ...

    def authorize_root_at(
        self, project_id: str, source: str, parent: str, name: str
    ) -> ExternalRootRef:
        """Authorize one file at an existing local resource directory."""
        ...

    def authorize_roots(
        self, project_id: str, sources: tuple[str, ...], mounts: tuple[str, ...]
    ) -> tuple[ExternalRootRef, ...]:
        """全量预检后在一个事务内激活多处外部根。"""
        ...

    def assert_import_roots_linkable(self, project_id: str, sources: tuple[str, ...]) -> None:
        """关联导入创建任务前的只读包含预检; 与已生效关联根重叠则拒 `source_overlap`。"""
        ...

    def revoke_root(self, root_id: str, project_id: str | None = None) -> ExternalRootRef:
        """撤销授权。软撤销留痕: 能写项目外文件的能力不能无痕消失。"""
        ...

    def external_roots(self, project_id: str) -> tuple[ExternalRootRef, ...]:
        """该项目当前有效的关联根。"""
        ...

    def writable_roots(self, project_id: str) -> tuple[str, ...]:
        """该项目允许写入的绝对根集合。

        主进程授权白名单与 Agent 沙箱的 `sandboxPolicy.writableRoots`
        都由这一处派生 —— 两套来源必然会漂移成一处能写一处不能写。
        """
        ...

    # ---- 删除接缝 ----

    def issue_trash_token(self, project_id: str, path: str) -> str:
        """签发一次性删除令牌。渲染层只持有令牌, 不持有绝对路径。"""
        ...

    def redeem_trash_token(self, trash_token: str) -> str:
        """兑换令牌 → 待删绝对路径。仅限 Electron 主进程调用, 用后即焚。"""
        ...

    def complete_trash_token(self, trash_token: str) -> str:
        """Publish a successful OS trash result and return its logical path."""
        ...

    # ---- 存量迁移 ----

    def migration_plan(self, project_id: str) -> object:
        """dry-run: 列出会搬什么、多大、有没有冲突。不动任何文件。

        返回域内的计划记录 (跨域只需要「拿去展示 / 原样回传」), 因此这里不把它
        的字段结构再复制一份到契约里 —— 复制一份就等于两处定义同一件事。
        """
        ...

    def migrate_project(self, project_id: str, skip: tuple[str, ...] = ()) -> object:
        """按计划逐项迁移。`skip` 里的条目保持原位 (用户选了「暂不迁移」)。"""
        ...

    # ---- 文件事件 ----

    def event_cursor(self, project_id: str) -> tuple[str, int]:
        """该项目当前的 (epoch, last_seq)。客户端据此发起续传。"""
        ...

    def subscribe(
        self,
        project_id: str,
        epoch: str,
        from_seq: int,
    ) -> AsyncIterator[FileEvent]:
        """订阅文件事件, 从 `from_seq` 之后开始。

        返回**异步**迭代器: 它要作为 SSE 的 body 被消费, 同步阻塞迭代器会堵住
        事件循环 (既有 SSE 端点的异步性也在传给 `StreamingResponse` 的那个
        生成器里)。`epoch` 不匹配时第一条一定是 RESCAN。
        """
        ...

    async def close_events(self) -> None:
        """Stop watchers and release event subscribers at product shutdown."""
        ...

    async def refresh_events(self, project_id: str) -> None:
        """Keep the authorized event roots current independently of UI subscribers."""
        ...


__all__ = [
    "ArtifactScope",
    "ArtifactScopeKind",
    "ArtifactStorageLocation",
    "AssetKind",
    "AssetBinding",
    "AssetState",
    "AssetOrigin",
    "AssetPage",
    "AssetTree",
    "ContentSnapshot",
    "ContentWriteReceipt",
    "VerifiedArtifactContent",
    "ContentPort",
    "ContentImportResultObserver",
    "ContentImportSourceResult",
    "EventSource",
    "ExternalRootRef",
    "FileAssetRef",
    "FileEvent",
    "FileEventKind",
    "ImportMode",
    "ImportFailurePolicy",
    "DISK_FULL_ERROR",
    "IMPORT_CANCELLED_ERROR",
    "PreparedContent",
    "ProjectLayout",
    "ProjectRef",
    "ResourceEntry",
    "ResourceHit",
    "ResourceMatch",
    "ResourceReveal",
    "ResourceRevealKind",
    "ResourceSearchResult",
    "ResourceScanObserver",
    "RootKind",
]
