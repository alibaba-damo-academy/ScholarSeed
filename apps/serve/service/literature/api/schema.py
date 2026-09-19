"""文献库 HTTP 请求/响应契约。"""

from __future__ import annotations

from pydantic import BaseModel, model_validator

from service.literature.schema import PublicationType

PUBTYPE_REQUIRED_FIELDS: dict[PublicationType, tuple[str, ...]] = {
    PublicationType.INPROCEEDINGS: ("title", "author", "venue", "year"),
    PublicationType.ARTICLE: ("title", "author", "venue", "year"),
    PublicationType.MISC: ("title",),
    PublicationType.BOOK: ("title", "author", "publisher", "year"),
    PublicationType.TECHREPORT: ("title", "author", "publisher", "year"),
    PublicationType.INCOLLECTION: ("title", "author", "venue", "publisher", "year"),
    PublicationType.PHDTHESIS: ("title", "author", "publisher", "year"),
    PublicationType.MASTERSTHESIS: ("title", "author", "publisher", "year"),
}


class NoteOut(BaseModel):
    """笔记输出。"""

    id: str
    text: str
    created_at: float = 0.0
    title: str = ""
    updated_at: float = 0.0
    version: int = 1
    position: int = 0


class ItemOut(BaseModel):
    """单条文献输出。"""

    id: str
    pubtype: PublicationType
    title: str
    author: str
    authors: str
    url: str
    venue: str
    journal: str
    year: int | None = None
    pages: str
    volume: str
    fulltext: str
    tags: list[str]
    abstract: str
    doi: str
    arxiv: str
    publisher: str
    address: str
    collection: str
    added_at: float
    notes: list[NoteOut]


class ItemCreate(BaseModel):
    """新增/更新文献请求。"""

    id: str
    pubtype: PublicationType = PublicationType.MISC
    title: str
    author: str = ""
    authors: str = ""
    url: str = ""
    venue: str = ""
    journal: str = ""
    year: int | None = None
    pages: str = ""
    volume: str = ""
    fulltext: str = "none"
    tags: list[str] = []
    abstract: str = ""
    doi: str = ""
    arxiv: str = ""
    publisher: str = ""
    address: str = ""
    collection: str = ""
    added_at: float = 0.0
    notes: list[NoteOut] = []

    @model_validator(mode="after")
    def validate_bibliography(self) -> "ItemCreate":
        """按文献类型校验统一超集中的必填字段。"""

        values: dict[str, object] = {
            "title": self.title,
            "author": self.author or self.authors,
            "venue": self.venue or self.journal,
            "year": self.year,
            "publisher": self.publisher,
        }
        missing = [
            field for field in PUBTYPE_REQUIRED_FIELDS[self.pubtype] if not values.get(field)
        ]
        if missing:
            raise ValueError(f"{self.pubtype.value} requires fields: {', '.join(missing)}")
        return self


class ListResponse(BaseModel):
    """文献列表响应。"""

    items: list[ItemOut]
    total: int


class CollectionOut(BaseModel):
    """分类输出。"""

    name: str
    count: int
    parent: str = ""
    project_id: str | None = None


class TagOut(BaseModel):
    """标签及计数输出。"""

    name: str
    count: int


class BatchIds(BaseModel):
    """批量 id 请求。"""

    ids: list[str]


class BatchTag(BaseModel):
    """批量标签请求。"""

    ids: list[str]
    tag: str


class BatchCollection(BaseModel):
    """批量改分类请求。"""

    ids: list[str]
    collection: str


class CollectionCreate(BaseModel):
    """新建分类请求。"""

    name: str
    parent: str = ""
    project_id: str = ""


class CollectionRename(BaseModel):
    """重命名分类请求。"""

    old_name: str
    new_name: str


class BibtexExport(BaseModel):
    """导出 BibTeX 请求。"""

    ids: list[str]


class BibtexResponse(BaseModel):
    """导出 BibTeX 响应。"""

    bibtex: str
    count: int


class CountResponse(BaseModel):
    """计数响应。"""

    removed: int


__all__ = [
    "BatchCollection",
    "BatchIds",
    "BatchTag",
    "BibtexExport",
    "BibtexResponse",
    "CollectionCreate",
    "CollectionOut",
    "CollectionRename",
    "CountResponse",
    "ItemCreate",
    "ItemOut",
    "ListResponse",
    "NoteOut",
    "PUBTYPE_REQUIRED_FIELDS",
    "TagOut",
]
