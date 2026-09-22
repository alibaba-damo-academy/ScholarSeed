"""Global literature-library domain records."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from uuid import uuid4

UNFILED_COLLECTION = "未整理"
RECENT_WINDOW_DAYS = 7


def new_item_id() -> str:
    """文献主键：不携带任何语义的 uuid4。

    文献库不做重复判定（proposal 91）：主键一旦由 DOI / 标题 / 文件字节推导，
    就变成身份函数，"再次导入同一条"会命中既存行并触发覆盖式合并，用户改过的
    题录、标签、分类、笔记都可能被导入冲掉。id 只负责定位一行，是否重复留给
    用户自己判断。所有入库渠道都必须走这里，禁止再各自推导 id。
    """

    return uuid4().hex


class FulltextStatus(str, Enum):
    NONE = "none"
    OA = "oa"
    RESTRICTED = "restricted"
    READY = "ready"
    FETCHING = "fetching"


class AttachmentRole(str, Enum):
    PRIMARY = "primary"
    SUPPLEMENTARY = "supplementary"


PDF_MEDIA_TYPE = "application/pdf"
PNG_MEDIA_TYPE = "image/png"
BINARY_MEDIA_TYPE = "application/octet-stream"


class ImportSource(str, Enum):
    LOCAL_FILE = "local"
    ZOTERO_DIR = "zotero"
    IDENTIFIER = "doi"
    RESOURCE_MARK = "resource"


class PublicationType(str, Enum):
    ARTICLE = "article"
    BOOK = "book"
    BOOKLET = "booklet"
    CONFERENCE = "conference"
    INBOOK = "inbook"
    INCOLLECTION = "incollection"
    INPROCEEDINGS = "inproceedings"
    MANUAL = "manual"
    MASTERSTHESIS = "mastersthesis"
    MISC = "misc"
    PHDTHESIS = "phdthesis"
    PROCEEDINGS = "proceedings"
    TECHREPORT = "techreport"
    UNPUBLISHED = "unpublished"


@dataclass(frozen=True)
class LiteratureNote:
    id: str
    text: str
    created_at: float = 0.0
    title: str = ""
    updated_at: float = 0.0
    version: int = 1
    position: int = 0


@dataclass(frozen=True)
class LiteratureAttachment:
    """一份文献独占的附件文件。

    附件不是"指向某处字节"的链接: ``path`` 恒为文献托管目录里只属于这一行的副本,
    文件名 ``{literature_id}-{md5}-{uuid}.{ext}`` 保证同字节的两条文献也各存一份,
    删文献就一定连文件一起删。``revision`` 是这份字节的内容修订号, 写入时算好存下:
    全文索引缓存以它为键, 而删除那一刻文件已经 unlink, 既读不到字节也没有可反推的
    文件名, 只有行里这一列还能指出该忘掉哪一份索引。
    """

    id: str
    literature_id: str
    name: str
    path: str = ""
    revision: str = ""
    kind: str = "file"
    role: AttachmentRole = AttachmentRole.SUPPLEMENTARY
    media_type: str = BINARY_MEDIA_TYPE
    created_at: float = 0.0


@dataclass(frozen=True)
class AttachmentFile:
    """一份已落盘、等着绑到文献行上的附件副本。

    批量落库 (Zotero 导入) 要把"哪个文件属于哪条文献"整批交给仓储, 四个字段都是
    必需的绑定信息, 用裸元组传会让调用方靠位置猜含义。
    """

    literature_id: str
    path: str
    name: str
    revision: str


@dataclass(frozen=True)
class DeletedAttachment:
    """What one attachment deletion removed, so the caller can finish cleaning up.

    The physical file and any full-text index derived from it are owned outside
    the repository transaction, so the row's own identity has to travel back to
    the caller instead of being reduced to a bare path.
    """

    literature_id: str
    attachment_id: str
    path: str
    revision: str
    role: AttachmentRole


@dataclass(frozen=True)
class LiteratureItem:
    id: str
    title: str
    authors: str = ""
    journal: str = ""
    year: int | None = None
    fulltext: FulltextStatus = FulltextStatus.NONE
    pubtype: PublicationType = PublicationType.MISC
    item_type: str = "document"
    citation_key: str = ""
    subtitle: str = ""
    published_date: str = ""
    url: str = ""
    venue: str = ""
    pages: str = ""
    volume: str = ""
    number: str = ""
    arxiv: str = ""
    doi: str = ""
    isbn: str = ""
    publisher: str = ""
    address: str = ""
    abstract: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)
    collections: tuple[str, ...] = field(default_factory=tuple)
    collection: str = ""
    added_at: float = 0.0
    updated_at: float = 0.0
    version: int = 1
    has_pdf: bool = False
    notes: tuple[LiteratureNote, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class LiteratureCollection:
    name: str
    count: int
    parent: str = ""
    id: str = ""
    project_id: str | None = None


@dataclass(frozen=True)
class LiteratureView:
    items: tuple[LiteratureItem, ...] = field(default_factory=tuple)
    collections: tuple[LiteratureCollection, ...] = field(default_factory=tuple)
