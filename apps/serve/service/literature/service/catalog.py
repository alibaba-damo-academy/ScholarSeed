"""文献库编目：筛选、排序与 BibTeX 导出。

所有函数都是纯函数，只操作不可变的 ``LiteratureView`` / ``LiteratureItem``，
不触碰 IO。持久化由 ``persistence/store.py`` 的 ``LiteratureRepository`` 负责。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum

from service.literature.schema import (
    RECENT_WINDOW_DAYS,
    UNFILED_COLLECTION,
    LiteratureItem,
    LiteratureView,
    PublicationType,
)


class SortKey(str, Enum):
    """列表排序字段。"""

    ADDED = "added"
    TITLE = "title"
    AUTHORS = "authors"
    JOURNAL = "journal"
    YEAR = "year"


class PdfFilter(str, Enum):
    """PDF 状态筛选。"""

    ALL = "all"
    HAS_PDF = "pdf"
    NO_PDF = "meta"


#: 「全部」伪筛选值。
FILTER_ALL = "all"

#: 年份缺失时参与排序的兜底值。
MISSING_YEAR_ORDER = -1


@dataclass(frozen=True)
class ListQuery:
    """列表视图查询条件；全部可选，缺省即不筛。"""

    search: str = ""
    tag: str = FILTER_ALL
    fulltext: str = FILTER_ALL
    year: str = FILTER_ALL
    collection: str = FILTER_ALL
    recent_only: bool = False
    pdf: PdfFilter = PdfFilter.ALL
    sort: SortKey = SortKey.ADDED
    descending: bool = False


def _matches_search(item: LiteratureItem, needle: str) -> bool:
    """标题/作者/期刊/DOI/年份/分类/标签任一命中。"""

    if not needle:
        return True
    haystack = " ".join(
        (
            item.title,
            item.authors,
            item.venue or item.journal,
            item.doi,
            item.arxiv,
            item.publisher,
            str(item.year or ""),
            item.collection,
            " ".join(item.tags),
        )
    ).lower()
    return needle in haystack


def _sort_value(item: LiteratureItem, key: SortKey) -> tuple:
    """排序键。"""

    if key is SortKey.ADDED:
        return (item.added_at, item.title.lower())
    if key is SortKey.YEAR:
        return (item.year if item.year is not None else MISSING_YEAR_ORDER, item.title.lower())
    if key is SortKey.AUTHORS:
        return (item.authors.lower(), item.title.lower())
    if key is SortKey.JOURNAL:
        return (item.journal.lower(), item.title.lower())
    return (item.title.lower(),)


def item_collection(item: LiteratureItem) -> str:
    """条目所属分类；空串归入「未整理」。"""

    return item.collection or UNFILED_COLLECTION


def is_recent(item: LiteratureItem, *, now: float | None = None) -> bool:
    """是否属于「最近添加」。"""

    if item.added_at <= 0:
        return False
    moment = time.time() if now is None else now
    return (moment - item.added_at) <= RECENT_WINDOW_DAYS * 86400


def _matches_pdf(item: LiteratureItem, pdf: PdfFilter) -> bool:
    """PDF 状态筛选。"""

    if pdf is PdfFilter.ALL:
        return True
    return item.has_pdf if pdf is PdfFilter.HAS_PDF else not item.has_pdf


def apply_query(
    items: tuple[LiteratureItem, ...],
    query: ListQuery,
    *,
    now: float | None = None,
) -> tuple[LiteratureItem, ...]:
    """按查询条件筛选并排序。"""

    needle = query.search.strip().lower()
    filtered = [
        item
        for item in items
        if _matches_search(item, needle)
        and (query.tag == FILTER_ALL or query.tag in item.tags)
        and (query.fulltext == FILTER_ALL or item.fulltext.value == query.fulltext)
        and (query.year == FILTER_ALL or str(item.year or "") == query.year)
        and (query.collection == FILTER_ALL or item_collection(item) == query.collection)
        and (not query.recent_only or is_recent(item, now=now))
        and _matches_pdf(item, query.pdf)
    ]
    reverse = query.descending or query.sort is SortKey.ADDED
    filtered.sort(key=lambda item: _sort_value(item, query.sort), reverse=reverse)
    return tuple(filtered)


def append_items(
    view: LiteratureView,
    incoming: tuple[LiteratureItem, ...],
) -> tuple[LiteratureView, int]:
    """把导入的条目追加到视图末尾，返回 ``(新视图, 追加条数)``。

    文献库不做重复判定（proposal 91）：条目的 id 是 `new_item_id()` 生成的 uuid4，
    导入永远带来新行，所以这里既不建 id 索引也不做字段级合并。既存行——包括用户
    改过的题录、标签、分类关联、笔记——原样保留，不会被任何一次导入触碰。
    """

    return (
        LiteratureView(items=(*view.items, *incoming), collections=view.collections),
        len(incoming),
    )


#: BibTeX 文本中需转义的特殊字符。大括号和反斜杠不能删除：
#: Zotero 用大括号保护专有名词大小写，反斜杠承载 LaTeX 命令。
_BIB_ESCAPE_SOURCE: dict[str, str | int | None] = {
    "&": r"\&",
    "%": r"\%",
    "_": r"\_",
    "#": r"\#",
}
_BIB_ESCAPE = str.maketrans(_BIB_ESCAPE_SOURCE)
_CITE_KEY_STRIP_SOURCE: dict[str, str | int | None] = {"{": "", "}": "", "\\": ""}


def _cite_key(item: LiteratureItem) -> str:
    """引用键：首作者姓 + 年份。"""

    surname = ""
    if item.authors:
        first = item.authors.split(",")[0].strip()
        parts = first.split()
        surname = (parts[-1] if parts else first).translate(str.maketrans(_CITE_KEY_STRIP_SOURCE))
    surname = "".join(ch for ch in surname if ch.isalnum()) or "ref"
    return f"{surname}{item.year or ''}"


def to_bibtex(items: tuple[LiteratureItem, ...]) -> str:
    """导出 BibTeX；重复引用键自动加后缀。"""

    used: dict[str, int] = {}
    blocks: list[str] = []
    for item in items:
        base = item.citation_key.strip() or _cite_key(item)
        base = "".join(ch for ch in base if ch.isalnum() or ch in "-_:")
        base = base or "ref"
        seen = used.get(base, 0)
        used[base] = seen + 1
        key = base if seen == 0 else f"{base}-{seen + 1}"
        fields = [
            ("title", item.title),
            ("author", item.authors),
            (
                "journal" if item.pubtype is PublicationType.ARTICLE else "booktitle",
                item.venue or item.journal,
            ),
            ("year", str(item.year) if item.year else ""),
            ("pages", item.pages),
            ("volume", item.volume),
            ("doi", item.doi),
            ("url", item.url),
            ("eprint", item.arxiv),
            ("publisher", item.publisher),
            ("address", item.address),
        ]
        lines = [
            f"  {name} = {{{value.translate(_BIB_ESCAPE)}}}," for name, value in fields if value
        ]
        blocks.append(f"@{item.pubtype.value}{{" + key + ",\n" + "\n".join(lines) + "\n}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


__all__ = [
    "FILTER_ALL",
    "ListQuery",
    "PdfFilter",
    "SortKey",
    "append_items",
    "apply_query",
    "is_recent",
    "item_collection",
    "to_bibtex",
]
