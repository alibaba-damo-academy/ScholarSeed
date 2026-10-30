"""文献库领域模型 (literature 域, 开发 3 拥有)。

架构文档 §3.3: 本域负责文献元数据、作者、DOI、年份、期刊、PDF 关联、
搜索筛选排序集合详情, 以及「文献上下文和引用定位所需的领域数据」。

**不实现 PDF Viewer**(那是开发 4 的 workbench 域), 也**不绕过 ContentPort**
访问文件。本文件只放文献库自己的领域概念。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

MAX_IMPORT_BYTES = 1024 * 1024 * 1024

#: 单批题录上限, 导入与导出共用同一个口径。
#: 超限一律报错 (导入 ``too_many_records`` / 导出 ``EXPORT_TOO_MANY_ITEMS``),
#: 不做静默裁剪: 用户勾选了 3000 条却只拿到 2000 条, 比失败更难发现。
MAX_BATCH_RECORDS = 2000

LIBRARY_INVALID = "literature_library_invalid"
COLLECTION_NOT_FOUND = "COLLECTION_NOT_FOUND"
COLLECTION_PARENT_INVALID = "COLLECTION_PARENT_INVALID"
COLLECTION_CYCLE = "COLLECTION_CYCLE"
COLLECTION_NAME_REQUIRED = "COLLECTION_NAME_REQUIRED"
LIBRARY_UNAVAILABLE = "literature_library_unavailable"
IMPORT_CONFLICT = "literature_import_conflict"
IMPORT_COLLECTION_UNAVAILABLE = "literature_import_collection_unavailable"
NOTE_BODY_REQUIRED = "literature_note_body_required"
NOTE_NOT_FOUND = "literature_note_not_found"
NOTE_TITLE_REQUIRED = "literature_note_title_required"
NOTE_VERSION_CONFLICT = "literature_note_version_conflict"
TAXONOMY_NOT_FOUND = "literature_taxonomy_not_found"
TAXONOMY_CONFLICT = "literature_taxonomy_conflict"
TAXONOMY_REVISION_CONFLICT = "literature_taxonomy_revision_conflict"
TAXONOMY_PROJECT_REQUIRED = "literature_taxonomy_project_required"
TAXONOMY_ITEM_UNAVAILABLE = "literature_taxonomy_item_unavailable"


class FulltextState(str, Enum):
    """全文获取状态 (PRD「全文状态」)。

    默认 MISSING 而不是乐观标记为已就绪: 虚标会让用户以为能读全文,
    点开却是空的。宁可显示"未获取"也不误报。
    """

    MISSING = "missing"
    #: 已关联本地 PDF。
    READY = "ready"
    #: 用户手动标记为无法获取, 避免反复尝试。
    UNAVAILABLE = "unavailable"


class LiteratureSort(str, Enum):
    """文献列表排序维度 (架构文档 §3.3「搜索、筛选、排序」)。"""

    TITLE = "title"
    YEAR = "year"
    AUTHOR = "author"
    #: 入库时间, 默认维度。
    ADDED = "added"


class LiteratureFormat(str, Enum):
    """可导入的题录格式 (架构文档 §3.3「PDF、Bib、RIS 导入流程」)。"""

    BIBTEX = "bibtex"
    RIS = "ris"
    PDF = "pdf"


class LiteratureError(Exception):
    """文献库领域错误。`code` 作为 HTTP detail 原样透出。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class LiteratureRef:
    """文献条目的稳定引用 (架构文档 §3.3 对外提供)。

    跨域只传 `id`: AI 上下文附加文献时用它, 不传绝对路径也不传整条元数据 ——
    元数据随时可能被用户编辑, 传引用才不会拿到过期快照。
    """

    id: str
    title: str


@dataclass(frozen=True)
class LiteratureQuery:
    """一次文献列表查询的完整条件。

    做成不可变记录而非一串散参数: 前端「筛选后再排序」是两次动作, 但后端
    必须按一次完整条件求值。散参数容易漏传其中一个, 表现为"排序把筛选清掉了"。
    """

    keyword: str = ""
    #: 标签筛选; 空元组表示不限。
    tags: tuple[str, ...] = ()
    year_from: int | None = None
    year_to: int | None = None
    fulltext: FulltextState | None = None
    sort: LiteratureSort = LiteratureSort.ADDED
    descending: bool = True


__all__ = [
    "FulltextState",
    "LiteratureError",
    "LiteratureFormat",
    "LiteratureQuery",
    "LiteratureRef",
    "LiteratureSort",
    "NOTE_BODY_REQUIRED",
    "NOTE_NOT_FOUND",
    "NOTE_TITLE_REQUIRED",
    "NOTE_VERSION_CONFLICT",
]
