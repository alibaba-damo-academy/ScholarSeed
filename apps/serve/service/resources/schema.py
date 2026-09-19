"""ScholarSeed 资料库领域的请求/响应契约 (MVP 0.2)。

这些 dataclass 是资料库前后端唯一的字段真源：前端
`features/resource/state.ts` 的 ResourceNode 与此保持一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class NodeKind(str, Enum):
    """资料树节点种类。"""

    FILE = "file"
    DIR = "dir"


class ImportMode(str, Enum):
    """导入方式 (PRD「资料导入」)。

    COPY 在项目空间内复制一份副本, Agent 只改副本, 本地原文件不动;
    LINK 不复制不搬移, 授权 Agent 直接操作用户原始文件。
    """

    COPY = "copy"
    LINK = "link"


@dataclass(frozen=True)
class ResourceNode:
    """资料树的一个节点。path 相对项目根, 作为稳定标识。"""

    path: str
    name: str
    kind: NodeKind
    count: int | None = None
    children: tuple["ResourceNode", ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ResourceTreeView:
    """`GET /api/resource/tree` 的响应。"""

    root: str
    nodes: tuple[ResourceNode, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ImportRequest:
    """`POST /api/resource/import` 的请求体。"""

    mode: ImportMode
    """待导入的本机绝对路径。"""
    sources: tuple[str, ...]
    """落地目录, 相对项目根; 空串表示项目根。"""
    target_dir: str = ""


class NodeAction(str, Enum):
    """`POST /api/resource/node` 支持的资料管理动作 (PRD「资料管理」)。

    用单一端点 + action 判别式而非五个端点: 这些动作共享同一套「项目根
    解析 + 越界校验 + 返回新节点」流程, 拆开会把该流程复制五遍。新增
    动作 = 新增一个枚举值与一个分派项, 不动流程骨架。
    """

    CREATE_DOCUMENT = "create_document"
    CREATE_FOLDER = "create_folder"
    RENAME = "rename"
    MOVE = "move"
    COPY = "copy"


@dataclass(frozen=True)
class NodeRequest:
    """`POST /api/resource/node` 的请求体。

    各字段按 action 取用: 新建用 `parent` + `name`; 重命名用 `path` +
    `name`; 移动用 `path` + `target_dir`; 复制用 `path` (+ 可选
    `target_dir`, 缺省为原地复制)。
    """

    action: NodeAction
    path: str = ""
    parent: str = ""
    name: str = ""
    target_dir: str | None = None
