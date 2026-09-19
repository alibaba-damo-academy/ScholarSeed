"""资料库领域模型 (resources 域, 开发 2 拥有)。

架构文档 §3.2 把资料库定为「目录、列表、筛选、文件属性、导入、本地搜索、
Agent 产物目录」。**文件操作本身不属于本域** —— 只经开发 1 的 `ContentPort`
访问, 不自行拼接根路径, 也不实现第二套文件 Store。

因此本文件只放资料库**自己的**概念: 视图筛选、Agent 产物目录约定、
以及对外的 `ResourceWriter` 落地位置规则。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

#: AI 摘录/回答落地的目录 (PRD「基于 AI 回答新建文档」)。
#:
#: 集中到一个目录而非散在项目根: 用户事后能一眼找到所有 AI 产物,
#: 也不会把人工整理的项目结构冲散。架构文档 §3.2 称其为
#: 「用户可见的 Agent 产物目录」。
#:
#: 目录名取 ASCII: 它会落盘并被命令行、外部工具与跨平台文件系统消费,
#: 中文名在非 UTF-8 locale 与 NFC/NFD 差异下不可靠。中文「AI 摘录」是展示名。
AGENT_OUTPUT_DIR = "ai_extracts"

#: 文献摘录默认落地目录。接口未指定 location 时仍聚合到可见的固定分组。
LITERATURE_EXCERPT_DIR = "文献摘录"

#: 新建 Markdown 资料的默认扩展名 (PRD「新建文档.md」)。
MARKDOWN_SUFFIX = ".md"
IMPORT_CONFLICT = "resource_import_operation_conflict"
IMPORT_INVALID = "resource_import_operation_invalid"
IMPORT_UNAVAILABLE = "resource_import_operation_unavailable"


class ResourceFilter(str, Enum):
    """资料列表的筛选维度 (架构文档 §3.2「列表、筛选」)。"""

    ALL = "all"
    #: 只看 AI 产物目录 (PRD「AI 侧: 从 Agent 产物导入」)。
    AGENT_OUTPUT = "agent_output"
    #: 只看可编辑文档 (写作筛选视图)。
    DOCUMENTS = "documents"


class AgentImportSourceKind(str, Enum):
    """Agent content kinds that can become a project resource."""

    ANSWER = "answer"
    ARTIFACT = "artifact"


class ImportDecisionAction(str, Enum):
    """Explicit collision decision for one local COPY source."""

    RENAME = "rename"
    REPLACE = "replace"


@dataclass(frozen=True)
class ResourceImportDecision:
    """Decision bound to the stable source index from an import plan."""

    source_index: int
    action: ImportDecisionAction


@dataclass(frozen=True)
class ResourceLocationRef:
    """资料落地位置 (架构文档 §3.2 对外提供的引用类型)。

    只描述「放到哪个目录、叫什么名」, 不含文件内容 ——
    内容由调用方给, 实际写入走 `ContentPort.create_text`。
    """

    #: 目标目录, 相对资料库根; 空串表示资料库根。
    parent: str
    #: 期望文件名 (可不带扩展名, 由 writer 补齐)。
    name: str


class ExcerptOperation(str, Enum):
    """摘录资料本次是首次创建还是向已有资料追加。"""

    CREATED = "created"
    UPDATED = "updated"


@dataclass(frozen=True)
class ResourceImportPlan:
    """Normalized durable request identity, allocated before any file creation."""

    operation_id: str
    fingerprint: str
    location: ResourceLocationRef


@dataclass(frozen=True)
class PdfExcerptSelection:
    """一段 PDF 原文及其页内定位。"""

    text: str
    page: int
    quads: tuple[tuple[float, float, float, float], ...] = ()


@dataclass(frozen=True)
class ResourceExcerptOutcome:
    """一次摘录聚合写入的稳定结果。"""

    operation: ExcerptOperation
    asset_path: str
    asset_name: str
    source_id: str
    added: int
    skipped: int
    total: int


def agent_output_location(name: str) -> ResourceLocationRef:
    """AI 产物的标准落地位置。"""

    return ResourceLocationRef(parent=AGENT_OUTPUT_DIR, name=name)


__all__ = [
    "AGENT_OUTPUT_DIR",
    "LITERATURE_EXCERPT_DIR",
    "MARKDOWN_SUFFIX",
    "ExcerptOperation",
    "PdfExcerptSelection",
    "ResourceExcerptOutcome",
    "ResourceFilter",
    "ResourceLocationRef",
    "AgentImportSourceKind",
    "ImportDecisionAction",
    "ResourceImportDecision",
    "agent_output_location",
]
