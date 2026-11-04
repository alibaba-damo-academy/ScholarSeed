"""content 域的领域模型与错误 (开发 1 拥有)。

架构文档 §2.2 要求每个域有 `domain/` 层。放在这里的是**域内**概念:
项目解析规则、根目录语义、域错误码。跨域共享的形状在
`service/platform/content.py`, 两者不重复定义 —— domain 引用 platform 的记录,
反向不成立。

`ContentError.code` 是稳定错误码, HTTP 层原样透出让前端按码分支;
后端不承担文案与多语言。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from service.platform.content import ProjectLayout, ProjectRef, RootKind


class OperationState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


OPERATION_INTERRUPTED = "content_operation_interrupted"


#: LEGACY 布局下资料库根相对项目根的位置。空串 = 项目根本身。
#:
#: 0.2 之前的「添加项目」就是选一个本地文件夹, 资料直接铺在项目根下,
#: 因此资料库根 == 项目根。存量项目必须逐字节保持这个取值。
RESOURCES_ROOT_RELATIVE = ""

#: LEGACY 布局下文献库 PDF 与题录的落地位置 (相对项目根)。
#:
#: 单独开一层而不与资料混放: PRD 把「资料」与「文献」定义为两类不同对象,
#: 文献是"客观不能更改的素材接入层"。物理分开后, 资料树不会被大量 PDF 冲散。
LITERATURE_ROOT_RELATIVE = "文献"

#: MANAGED 布局的内置双库目录名 (proposal 47 §5.3)。新建项目一律用这两个。
#:
#: 用 ASCII 而非中文: 目录名会流经命令行、外部工具与跨平台文件系统,
#: 中文名在非 UTF-8 locale、NFC/NFD 归一化差异下会解析失败。中文是**展示名**,
#: 由前端文案提供, 不落盘。
MANAGED_RESOURCES_ROOT_RELATIVE = "resources"
MANAGED_LITERATURE_ROOT_RELATIVE = "literature"
ARTIFACTS_ROOT_RELATIVE = "artifacts"
SESSIONS_ROOT_RELATIVE = "sessions"
OWNED_ROOT_KINDS = frozenset({RootKind.ARTIFACTS, RootKind.SESSIONS})
WORKING_CONTENT_CONFLICT = "working_content_conflict"
WORKING_CONTENT_PATH_INVALID = "working_content_path_invalid"
PREPARED_CONFLICT = "prepared_content_conflict"
PREPARED_UNAVAILABLE = "prepared_content_unavailable"

#: 项目内产品状态目录 (文献库 JSON 等)。集中在一处, 不散落在用户资料里。
PROJECT_STATE_DIRNAME = ".scholarseed"
ROOT_UNAVAILABLE_ERROR = "root_unavailable"
PROJECT_RECOVERY_PENDING = "project_recovery_pending"
ROOT_SOURCE_CHANGED_ERROR = "root_source_changed"
ROOT_BUSY_ERROR = "root_busy"
PATH_OUTSIDE_ROOT_ERROR = "path_outside_root"
READ_FAILED = "read_failed"

#: 不进入任何扫描的目录名 (版本库内部、依赖、系统噪声、产品自己的状态目录)。
IGNORED_NAMES = frozenset(
    {
        ".git",
        ".svn",
        ".hg",
        "node_modules",
        "__pycache__",
        ".venv",
        ".DS_Store",
        ".scholarseed",
        ".damoagent",
    }
)


class ContentError(Exception):
    """content 域的领域错误。`code` 会作为 HTTP detail 原样回给前端。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ContentReadPermissionError(ContentError):
    """A refused read with its authorized project-relative location."""

    def __init__(self, path: str) -> None:
        super().__init__(READ_FAILED)
        self.path = path


@dataclass(frozen=True)
class RootLocation:
    """一个被监听根的解析结果。"""

    kind: RootKind
    #: 相对项目根的位置。
    relative: str
    #: 绝对路径。
    absolute: Path


#: (布局, 根种类) → 相对项目根的位置。新增布局 = 加一行, 不改解析代码。
ROOT_RELATIVE: dict[tuple[ProjectLayout, RootKind], str] = {
    (ProjectLayout.LEGACY, RootKind.RESOURCES): RESOURCES_ROOT_RELATIVE,
    (ProjectLayout.LEGACY, RootKind.LITERATURE): LITERATURE_ROOT_RELATIVE,
    (ProjectLayout.MANAGED, RootKind.RESOURCES): MANAGED_RESOURCES_ROOT_RELATIVE,
    (ProjectLayout.MANAGED, RootKind.LITERATURE): MANAGED_LITERATURE_ROOT_RELATIVE,
    (ProjectLayout.LEGACY, RootKind.ARTIFACTS): ARTIFACTS_ROOT_RELATIVE,
    (ProjectLayout.MANAGED, RootKind.ARTIFACTS): ARTIFACTS_ROOT_RELATIVE,
    (ProjectLayout.LEGACY, RootKind.SESSIONS): SESSIONS_ROOT_RELATIVE,
    (ProjectLayout.MANAGED, RootKind.SESSIONS): SESSIONS_ROOT_RELATIVE,
}


def root_relative(layout: ProjectLayout, kind: RootKind) -> str:
    """(布局, 根种类) → 相对项目根的位置。

    存量项目走 LEGACY 分支, 取值与改造前逐字节一致 —— 若按 MANAGED 解析,
    老用户的资料树会立刻空掉。
    """

    return ROOT_RELATIVE[(layout, kind)]


def resolve_root(project: ProjectRef, kind: RootKind) -> RootLocation:
    """解析某个根的绝对位置。目录不存在时不报错 —— 由调用方决定是否创建。"""

    relative = root_relative(project.layout, kind)
    base = Path(project.root).expanduser().resolve()
    return RootLocation(
        kind=kind,
        relative=relative,
        absolute=base / relative if relative else base,
    )


def visible(name: str) -> bool:
    """该条目是否参与扫描与搜索。"""

    if name in IGNORED_NAMES:
        return False
    return not name.startswith(".")


__all__ = [
    "IGNORED_NAMES",
    "LITERATURE_ROOT_RELATIVE",
    "MANAGED_LITERATURE_ROOT_RELATIVE",
    "MANAGED_RESOURCES_ROOT_RELATIVE",
    "PATH_OUTSIDE_ROOT_ERROR",
    "PROJECT_STATE_DIRNAME",
    "RESOURCES_ROOT_RELATIVE",
    "ROOT_RELATIVE",
    "ContentError",
    "OperationState",
    "OPERATION_INTERRUPTED",
    "RootLocation",
    "resolve_root",
    "root_relative",
    "visible",
]
