"""HTTP projection for the global literature catalogue."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from dataclasses import asdict, replace
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import PurePath
from typing import Any, Sequence
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Query, Request
from starlette.datastructures import UploadFile
from starlette.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_404_NOT_FOUND, HTTP_503_SERVICE_UNAVAILABLE

from service.chat.persistence.catalog import SessionAccessError, SessionPrincipal
from service.content.domain.model import ContentError
from service.identity.utils import request_owner_id
from service.literature.api.papermeta import resolve_timeout_seconds
from service.literature.domain.cards import CARD_MAX_BYTES
from service.literature.domain.model import (
    IMPORT_COLLECTION_UNAVAILABLE,
    IMPORT_CONFLICT,
    LIBRARY_INVALID,
    MAX_BATCH_RECORDS,
    MAX_IMPORT_BYTES,
    NOTE_BODY_REQUIRED,
    NOTE_NOT_FOUND,
    NOTE_TITLE_REQUIRED,
    NOTE_VERSION_CONFLICT,
    LiteratureError,
)
from service.literature.persistence.cards import PaperCards
from service.literature.persistence.downloads import (
    DOWNLOAD_ADMISSION_UNAVAILABLE,
    DOWNLOAD_RECEIPT_INVALID,
    download_literature_ids,
)
from service.literature.persistence.files import (
    LiteratureFileBatch,
    attachment_size,
    delete_attachments,
    is_available_attachment,
    managed_object,
)
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.persistence.store import (
    TAXONOMY_ADD,
    TAXONOMY_REMOVE,
    LiteratureRepository,
    PageProjection,
)
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    AttachmentRole,
    FulltextStatus,
    LiteratureItem,
    PublicationType,
    new_item_id,
)
from service.literature.service.arxiv import ARXIV_INVALID, ArxivDownloadError
from service.literature.service.attachment import (
    ARXIV_ALREADY_ATTACHED,
    ATTACHMENT_INVALID,
    ATTACHMENT_TYPE_MISMATCH,
    AttachmentConflictError,
    AttachmentFormatError,
    attach_primary_pdf,
    forget_removed_indexes,
    has_usable_primary,
    upload_format,
)
from service.literature.service.bibliography import (
    INVALID_IDENTIFIER,
    NETWORK_FAILED,
    NOT_FOUND,
    QUOTA_EXHAUSTED,
    UPSTREAM_FAILED,
    BibliographyError,
    fetch_identifier_bibliography,
)
from service.literature.service.catalog import is_recent, to_bibtex
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata
from service.literature.service.fulltext import (
    DOI_INVALID,
    FULLTEXT_IDENTIFIER_MISSING,
    FulltextDownloadError,
    fetch_identifier_pdf,
)
from service.literature.service.importer import (
    LiteratureImportError,
    parse_import,
)
from service.literature.service.outcome import (
    FULLTEXT_NO_ACCESS,
    FULLTEXT_NOT_FOUND,
    FULLTEXT_RATE_LIMITED,
    FULLTEXT_TIMEOUT,
    OUTCOME_STATUS,
    PRECONDITION_STATUS,
)
from service.literature.service.zotero import (
    ZoteroImportError,
    import_zotero,
    preview_zotero,
)
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.citations import PDF_INDEX_STATE
from service.platform.limits import UPLOAD_CHUNK_BYTES
from service.platform.records import RecordOwner, RecordTarget

API_PREFIX = "/api/v1"
DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
TASK_NOT_FOUND = "TASK_NOT_FOUND"
INVALID_BULK_OPERATION = "INVALID_BULK_OPERATION"
PROJECT_REQUIRED = "LITERATURE_PROJECT_REQUIRED"
LITERATURE_NOT_FOUND = "LITERATURE_NOT_FOUND"
LITERATURE_REFERENCED = "LITERATURE_REFERENCED_BY_PROJECTS"
UNSUPPORTED_EXPORT_FORMAT = "UNSUPPORTED_EXPORT_FORMAT"
EXPORT_TOO_MANY_ITEMS = "EXPORT_TOO_MANY_ITEMS"
#: 导出条数上限, 与导入 (MAX_BATCH_RECORDS) 同一个口径。
EXPORT_TOO_MANY_MESSAGE = f"一次最多导出 {MAX_BATCH_RECORDS} 条文献, 请分批导出"
#: 每个 facet 维度最多回多少个条目; 超出只保留计数最大的一批, 并如实报 total/truncated。
FACET_ENTRIES_LIMIT = 50
TERMINAL_FAILED = "failed"
TERMINAL_COMPLETED = "completed"
RUNNING = "running"
IMPORT_KIND = "import"
ZOTERO_SOURCE = "zotero"
ZOTERO_IMPORT_FAILED = "ZOTERO_IMPORT_FAILED"
UNSUPPORTED_IMPORT_SOURCE = "UNSUPPORTED_IMPORT_SOURCE"
#: 受理幂等头, 与 resources 导入任务用的是同一个约定。
IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
PDF_KIND = "pdf"
PDF_SUFFIX = ".pdf"
AVAILABLE = "available"
MISSING = "missing"
NOTE_INVALID_STATUS = 422
NOTE_CONFLICT_STATUS = 409
#: 库文件本身坏了 / 导入撞了同一份身份 → 冲突; 其余库错误是不可用。
LIBRARY_CONFLICT_STATUS = 409
LIBRARY_UNAVAILABLE_STATUS = 503
BIBTEX_FORMAT = "bibtex"
#: 导出超限用 422: 请求本身语义清楚, 只是超出了单次批量上限, 不是服务端故障。
EXPORT_LIMIT_STATUS = 422
PDF_FIELD = "file"
BIBLIOGRAPHY_FIELD = "files"
PDF_INVALID = "PDF_INVALID"
PDF_TOO_LARGE = "PDF_TOO_LARGE"
PDF_FILE_REQUIRED = "PDF_FILE_REQUIRED"
BIBLIOGRAPHY_INVALID = "BIBLIOGRAPHY_INVALID"
BIBLIOGRAPHY_FILE_REQUIRED = "BIBLIOGRAPHY_FILE_REQUIRED"
BIBLIOGRAPHY_TOO_LARGE = "BIBLIOGRAPHY_TOO_LARGE"
BIBLIOGRAPHY_ENTRY_INCOMPLETE = "BIBLIOGRAPHY_ENTRY_INCOMPLETE"
IDENTIFIER_FIELD = "identifier"
PROJECT_FIELD = "project_id"
COLLECTION_FIELD = "collection_id"
#: 标识符导入没有上传文件名, 而准入腿按扩展名挑解析器, 所以给它一个 .bib 名字。
IDENTIFIER_BIBLIOGRAPHY_NAME = "identifier.bib"
IDENTIFIER_REQUIRED = "IDENTIFIER_REQUIRED"
IDENTIFIER_ENTRY_INCOMPLETE = "IDENTIFIER_ENTRY_INCOMPLETE"
#: 上传没有文件名时的附件展示名 (路由已经先挡掉空文件名, 这里只为类型收窄兜底)。
ATTACHMENT_FALLBACK_NAME = "附件"
BULK_ADD_TAGS = "add_tags"
BULK_REMOVE_TAGS = "remove_tags"
BULK_MARK_READ = "mark_read"
BULK_LINK_PROJECT = "link_project"
BULK_UNLINK_PROJECT = "unlink_project"
# 获取全文区分未找到、无法访问、限流与超时，文案与前端 i18n 的
# detail.fulltext* 逐字一致; 这份中文是给 API 消费方与日志看的, 渲染层用自己的双语 key。
# 获取结果之外只剩前置校验问题, 它们不是「获取失败」, 各自保留可行动的提示。
FULLTEXT_ERROR_MESSAGES = {
    FULLTEXT_NOT_FOUND: "未找到全文",
    FULLTEXT_NO_ACCESS: "无法访问",
    FULLTEXT_RATE_LIMITED: "请求被限流",
    FULLTEXT_TIMEOUT: "下载超时，请稍后重试",
    ARXIV_INVALID: "arXiv 标识无效",
    DOI_INVALID: "DOI 标识无效",
    FULLTEXT_IDENTIFIER_MISSING: "请先补充 DOI 或 arXiv 标识",
    ARXIV_ALREADY_ATTACHED: "该文献已有主附件",
}
EDITABLE_FIELDS = {
    "citation_key",
    "item_type",
    "title",
    "subtitle",
    "authors",
    "publication",
    "year",
    "published_date",
    "abstract",
    "doi",
    "arxiv",
    "isbn",
    "url",
    "volume",
    "number",
    "pages",
    "publisher",
    "address",
}
PDF_ERROR_MESSAGES = {
    PDF_FILE_REQUIRED: "请选择 PDF 文件",
    PDF_INVALID: "文件不是有效的 PDF",
    PDF_TOO_LARGE: "PDF 文件过大",
}
ATTACHMENT_ERROR_MESSAGES = {
    ATTACHMENT_INVALID: "附件内容损坏或格式不受支持",
    ATTACHMENT_TYPE_MISMATCH: "附件名称或声明类型与实际内容不一致",
}
BIBLIOGRAPHY_ERROR_MESSAGES = {
    BIBLIOGRAPHY_FILE_REQUIRED: "请选择 Bib 或 RIS 文件",
    BIBLIOGRAPHY_INVALID: "Bib 或 RIS 文件格式错误",
    BIBLIOGRAPHY_TOO_LARGE: "导入文件总大小过大",
    BIBLIOGRAPHY_ENTRY_INCOMPLETE: "文件中存在缺少标题的条目",
}
#: 上游失败码沿用题录代理那一套 (PAPER_META_*), 渲染层因此能复用同一份分类与文案。
IDENTIFIER_ERROR_MESSAGES = {
    IDENTIFIER_REQUIRED: "请输入 ArXiv ID 或 DOI",
    IDENTIFIER_ENTRY_INCOMPLETE: "上游题录缺少标题，无法导入",
    INVALID_IDENTIFIER: "DOI 或 arXiv 编号无效",
    NOT_FOUND: "上游没有这条标识符的题录",
    QUOTA_EXHAUSTED: "元数据接口限流，请稍后重试",
    NETWORK_FAILED: "元数据接口网络请求失败",
    UPSTREAM_FAILED: "元数据接口请求失败或返回无效数据",
}
IMPORT_COLLECTION_MESSAGE = "分类已不可用，请刷新分类后重试"
ZOTERO_ERROR_MESSAGES = {
    "ZOTERO_UNAVAILABLE": "无法连接 Zotero Desktop，请确认 Zotero 正在运行且已允许本机应用通信",
    "ZOTERO_LOCAL_API_DISABLED": "Zotero Local API 未开启，请在 Zotero“设置 → 高级 → 常规”中开启“允许本机其他应用与 Zotero 通信”",
    "ZOTERO_API_ERROR": "Zotero Desktop 返回了错误",
    "ZOTERO_INVALID_RESPONSE": "Zotero Desktop 返回的数据格式无效",
    "ZOTERO_RESPONSE_TOO_LARGE": "Zotero 返回的数据过大",
    "ZOTERO_INVALID_PDF": "Zotero 中存在无法读取的 PDF",
    "ZOTERO_LIBRARY_EMPTY": "Zotero 个人文献库为空",
    "ZOTERO_INVALID_SELECTION": "选择的 Zotero 分类无效，请刷新后重试",
    "ZOTERO_LIBRARY_CHANGED": "Zotero 文献库已发生变化，请刷新分类树后重试",
}
LOGGER = logging.getLogger(__name__)


def project_scope(content: Any, project_id: str) -> str:
    """Validate an explicit project target; an empty id means the overview scope."""

    if not project_id:
        return ""
    if content is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    try:
        ref = content.project(project_id)
    except ContentError as error:
        raise HTTPException(status_code=400, detail=error.code) from error
    # 归档项目在全库面按隐藏处理, 与名称表/facet 同一语义; 取消归档即恢复。
    if ref.archived_at is not None:
        raise HTTPException(status_code=400, detail="unknown_project")
    return ref.id


def _project_scope(request: Request, project_id: str) -> str:
    return project_scope(getattr(request.app.state, "content", None), project_id)


def _import_collection(project_id: str, collection_id: str) -> str:
    """Validate an import landing collection against its own scope, up front.

    导入落点跟着左侧当前选择走, 而分类是分作用域的: 全局分类 (project_id IS NULL)
    与项目内的分类不能混用。落库那一跳本来就会校验并在事务里抛
    ``IMPORT_COLLECTION_UNAVAILABLE``, 但任务型导入 (Zotero) 跑在后台线程里, 那里
    抛错只能变成一条失败任务; 受理时先校验一次, 调用方才能立刻拿到 400。
    """

    if not collection_id:
        return ""
    known = {str(entry["id"]) for entry in LiteratureRepository().collections(project_id)}
    if collection_id not in known:
        raise HTTPException(
            status_code=400,
            detail={"code": IMPORT_COLLECTION_UNAVAILABLE, "message": IMPORT_COLLECTION_MESSAGE},
        )
    return collection_id


def _pdf_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": PDF_ERROR_MESSAGES[code]},
    )


def _primary_conflict(code: str) -> HTTPException:
    """已有可用主附件: 下载腿与上传腿报同一个码、同一份文案。

    不变式由附件域 owner ``attach_primary_pdf`` 持有, 这里只负责把它折成产品 HTTP。
    """

    return HTTPException(
        status_code=LIBRARY_CONFLICT_STATUS,
        detail={"code": code, "message": FULLTEXT_ERROR_MESSAGES[code]},
    )


def _attachment_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": ATTACHMENT_ERROR_MESSAGES[code]},
    )


def _bibliography_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": BIBLIOGRAPHY_ERROR_MESSAGES[code]},
    )


def _identifier_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": IDENTIFIER_ERROR_MESSAGES[code]},
    )


def _zotero_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": ZOTERO_ERROR_MESSAGES.get(code, "Zotero 导入失败")},
    )


#: 决定一次 Zotero 受理"做什么"的选项字段。同一份字段值就是同一次导入意图,
#: 因此可以复用还在跑的任务; 少一个字段都会把不同意图误判成重复。
ZOTERO_IDENTITY_FIELDS = (
    "collection_id",
    "import_collections",
    "include_unfiled",
    "preview_revision",
    "project_id",
    "selected_collection_keys",
    "selection",
)


def _zotero_import_identity(options: dict[str, Any]) -> str:
    """Hash the accepted Zotero scope into one idempotency identity.

    文献库是追加语义 (proposal 91): 重复受理不会被落库层吸收, 一次连点就是两份
    条目。所以幂等只能落在受理口 —— 同一次导入意图在它还跑着的时候必须拿回同一个
    任务, 而不是再起一个后台线程。
    """

    canonical: dict[str, Any] = {}
    for field in ZOTERO_IDENTITY_FIELDS:
        value = options.get(field)
        if field == "selection":
            entries = value if isinstance(value, list) else []
            value = sorted(
                (str(entry.get("key", "")), bool(entry.get("selected")))
                for entry in entries
                if isinstance(entry, dict) and entry.get("key")
            )
        elif field == "selected_collection_keys":
            keys = value if isinstance(value, list) else []
            value = sorted(str(key) for key in keys)
        canonical[field] = value
    payload = json.dumps(canonical, sort_keys=True, ensure_ascii=False, default=str)
    return sha256(payload.encode("utf-8")).hexdigest()


async def _upload_bytes(upload: UploadFile, total: int) -> tuple[bytes, int]:
    content = bytearray()
    while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
        content.extend(chunk)
        total += len(chunk)
        if total > MAX_IMPORT_BYTES:
            raise _bibliography_error(413, BIBLIOGRAPHY_TOO_LARGE)
    return bytes(content), total


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")


def _facet(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "name": entry["name"],
        "count": entry["count"],
        "color": entry.get("color") or None,
        "parent_id": entry.get("parent_id"),
        "project_id": entry.get("project_id"),
    }


def _tag_facet(entry: dict[str, Any]) -> dict[str, Any]:
    """标签 facet 带两个计数口径: count 按请求的项目范围, total 始终是全库。

    删除标签是全库操作, 前端确认框必须用 total, 否则在项目内会少报影响面。
    """

    return {**_facet(entry), "total": entry.get("total", entry["count"])}


def counts_payload(repository: LiteratureRepository, project_id: str) -> dict[str, int]:
    items = repository.view(project_id).items
    return {
        "all": len(items),
        "recent": sum(is_recent(item) for item in items),
        "without_collection": repository.filtered_total(
            project_id=project_id, without_collection=True, without_project=not bool(project_id)
        ),
        "unread": len(items),
        "without_fulltext": sum(item.fulltext is FulltextStatus.NONE for item in items),
    }


def _bounded_facet(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """把一个 facet 维度收成 {total, entries, truncated}。

    维度可能有几百个取值 (期刊尤其), 全量回给调用方既撑爆 AI 桥的 64 KiB 响应上限,
    也让用户界面拿到一堆用不上的行。截断必须显式: ``total`` 是真实取值数,
    ``truncated`` 告诉调用方 ``entries`` 只是计数最大的一批, 不是全貌。
    """

    return {
        "total": len(entries),
        "entries": entries[:FACET_ENTRIES_LIMIT],
        "truncated": len(entries) > FACET_ENTRIES_LIMIT,
    }


def facets_payload(repository: LiteratureRepository, project_id: str) -> dict[str, Any]:
    """侧栏 facet: 分类树与标签给全量, 聚合维度给有界视图。

    分类树喂着界面的树控件、标签喂着打标签选择器, 少一行用户就点不到, 所以不截断;
    年份/类型/期刊是统计维度, 走 ``_bounded_facet``。计数一律由 SQL 聚合出, 覆盖作用域
    内的全部条目 —— 之前是在 Python 里遍历 ``repository.list()`` (带 LIMIT), 库超过一页
    之后这三个维度只反映最新的一批条目。
    """

    counts = repository.facet_counts(project_id)
    return {
        "collections": [_facet(entry) for entry in repository.collections(project_id)],
        "tags": [_tag_facet(entry) for entry in repository.tags(project_id)],
        "item_types": _bounded_facet(
            [
                {"id": str(name), "name": str(name), "count": count}
                for name, count in counts["item_types"]
            ]
        ),
        "publications": _bounded_facet(
            [
                {"id": str(name), "name": str(name), "count": count}
                for name, count in counts["publications"]
            ]
        ),
        "years": _bounded_facet(
            [{"value": int(year), "count": count} for year, count in counts["years"]]
        ),
    }


def tag_facets_payload(
    repository: LiteratureRepository,
    *,
    project_id: str,
    collection_ids: tuple[str, ...],
    without_collection: bool = False,
    without_project: bool = False,
    recent_only: bool = False,
) -> dict[str, Any]:
    entries = repository.scoped_tags(
        project_id=project_id,
        collection_ids=collection_ids,
        without_collection=without_collection,
        without_project=without_project,
        recent_only=recent_only,
    )
    return {"tags": [_tag_facet(entry) for entry in entries]}


def project_names(content: Any) -> dict[str, str]:
    if content is None:
        return {}
    return {
        project.id: project.name for project in content.projects() if project.archived_at is None
    }


def projects_payload(content: Any, repository: LiteratureRepository) -> dict[str, Any]:
    if content is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    names = project_names(content)
    navigation = repository.project_navigation(tuple(names))
    try:
        current = content.project().id
    except ContentError:
        current = ""
    return {
        "projects": [
            {
                "id": project_id,
                "name": name,
                "count": navigation[project_id]["count"],
                "collections": [
                    _facet(collection) for collection in navigation[project_id]["collections"]
                ],
            }
            for project_id, name in names.items()
        ],
        "current": current if current in names else "",
    }


def summarize_items(
    items: Sequence[LiteratureItem],
    repository: LiteratureRepository,
    names: dict[str, str],
    project_id: str = "",
) -> list[dict[str, Any]]:
    """List projection shared by the product API and the bridge management plane."""

    return _summaries(items, repository, names, project_id)


def note_payload(note: Any) -> dict[str, Any]:
    return _note_payload(note)


def _availability(attachment: dict[str, Any]) -> str:
    """Report the attachment as the store really is, not as the row claims.

    A row can outlive its bytes (an interrupted cleanup, a restored database, a
    file removed behind the catalogue's back). Projecting it as available is what
    makes the item still look like it has readable full text, so the check is
    done here once per projected attachment instead of at open time only.
    """
    return AVAILABLE if is_available_attachment(str(attachment["path"])) else MISSING


def _pdf_indexes(request: Request):
    return getattr(request.app.state, PDF_INDEX_STATE, None)


def _attachment_payload(
    attachment: dict[str, Any],
    annotation_counts: dict[str, int],
    literature_id: str,
) -> dict[str, Any]:
    """一份附件的列表投影。可用性与大小各 stat 一次, 主附件复用同一份结果。"""

    return {
        "id": attachment["id"],
        "name": attachment["name"],
        "kind": attachment["kind"],
        "availability": _availability(attachment),
        "role": attachment["role"],
        "media_type": attachment["media_type"],
        "size": attachment_size(str(attachment["path"])),
        "created_at": _iso(attachment["created_at"]),
        "annotation_count": annotation_counts.get(attachment["id"], 0),
        "record_target": RecordTarget(
            RecordOwner.LITERATURE_ATTACHMENT, literature_id, attachment["id"]
        ).response(),
    }


def _primary_payload(attachment: dict[str, Any]) -> dict[str, Any]:
    """主附件载荷不带 created_at: 契约保持不变, 但不为它再 stat 一遍同一个文件。"""

    return {key: value for key, value in attachment.items() if key != "created_at"}


def _project_summary(
    item: LiteratureItem,
    projection: PageProjection,
    annotation_counts: dict[str, int],
    project_names: dict[str, str],
) -> dict[str, Any]:
    """纯拼装: 一行条目 + 整页读模型 → 列表载荷, 不再触发任何取数。"""

    attachments = [
        _attachment_payload(attachment, annotation_counts, item.id)
        for attachment in projection.attachments.get(item.id, ())
    ]
    primary = next(
        (
            attachment
            for attachment in attachments
            if attachment["role"] == AttachmentRole.PRIMARY.value
        ),
        None,
    )
    return {
        "id": item.id,
        "citation_key": item.citation_key or None,
        "item_type": item.item_type,
        "bib_type": item.pubtype.value,
        "title": item.title,
        "subtitle": item.subtitle or None,
        "creators_display": item.authors,
        "publication_display": item.venue or item.journal,
        "year": item.year,
        "published_date": item.published_date or None,
        "abstract": item.abstract or None,
        "doi": item.doi or None,
        "arxiv": item.arxiv or None,
        "isbn": item.isbn or None,
        "url": item.url or None,
        "volume": item.volume or None,
        "number": item.number or None,
        "pages": item.pages or None,
        "publisher": item.publisher or None,
        "address": item.address or None,
        "created_at": _iso(item.added_at),
        "updated_at": _iso(item.updated_at or item.added_at),
        "last_read_at": None,
        "read_progress": 0.0,
        "is_unread": True,
        "primary_attachment": None if primary is None else _primary_payload(primary),
        "attachments": attachments,
        "collections": [
            _facet(projection.collections[name])
            for name in projection.global_collections.get(item.id, ())
            if name in projection.collections
        ],
        "project_collections": [
            _facet(collection) for collection in projection.project_collections.get(item.id, ())
        ],
        "tags": [_facet(projection.tags[name]) for name in item.tags if name in projection.tags],
        "projects": [
            {"id": linked_id, "name": project_names[linked_id], "count": 1}
            for linked_id in projection.projects.get(item.id, ())
            if linked_id in project_names
        ],
        "version": item.version,
    }


def _summaries(
    items: Sequence[LiteratureItem],
    repository: LiteratureRepository,
    project_names: dict[str, str],
    project_id: str = "",
) -> list[dict[str, Any]]:
    """把一页条目投影成列表载荷。

    关联维度按页批量取一次 (`page_projection` + `annotation_counts_for`), 每行只做纯拼装。
    逐行取数时 50 行要开约 350 个连接、跑 100 次聚合全扫, 是列表在 Windows 上秒级延迟的
    直接来源; 按页取数把连接数压到个位数, 且成本不再随行数线性放大。
    """

    entries = tuple(items)
    identifiers = tuple(item.id for item in entries)
    projection = repository.page_projection(identifiers, project_id)
    annotation_counts = AttachmentRecordCatalog(repository.database).annotation_counts_for(
        identifiers
    )
    return [
        _project_summary(item, projection, annotation_counts.get(item.id, {}), project_names)
        for item in entries
    ]


def _summary(
    item: LiteratureItem,
    repository: LiteratureRepository,
    project_names: dict[str, str],
    project_id: str = "",
) -> dict[str, Any]:
    """单条投影 (详情 / 导入回执): 走与列表完全相同的批量路径, 不另写一份拼装。"""

    return _summaries((item,), repository, project_names, project_id)[0]


def _project_names(request: Request) -> dict[str, str]:
    """Resolve the live project dimension without persisting descriptive fields.

    归档项目从名称表里收起: 全库面的项目关联 (facet、条目徽章、scope 校验) 一并
    隐藏, 而 `literature_projects` 的关联行原样保留 —— 取消归档后名称表恢复解析,
    关联即恢复。真正清理关联行只发生在永久删除 (forget 的清理钩子)。
    """

    return project_names(getattr(request.app.state, "content", None))


def _detail(
    item: LiteratureItem,
    repository: LiteratureRepository,
    project_names: dict[str, str],
    project_id: str = "",
) -> dict[str, Any]:
    return {
        **_summary(item, repository, project_names, project_id),
        "citation_key": item.citation_key or None,
        "subtitle": item.subtitle or None,
        "abstract": item.abstract or None,
        "doi": item.doi or None,
        "arxiv": item.arxiv or None,
        "isbn": item.isbn or None,
        "issn": None,
        "url": item.url or None,
        "volume": item.volume or None,
        "number": item.number or None,
        "pages": item.pages or None,
        "publisher": item.publisher or None,
        "address": item.address or None,
        "attachment_count": len(repository.attachments(item.id)),
        "note_count": len(item.notes),
        "notes": [_note_payload(note) for note in item.notes],
    }


def _note_payload(note: Any) -> dict[str, Any]:
    return {
        "id": note.id,
        "title": note.title,
        "text": note.text,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
        "version": note.version,
        "position": note.position,
    }


def _note_error(error: LiteratureError) -> HTTPException:
    if error.code == NOTE_NOT_FOUND:
        return HTTPException(status_code=404, detail={"code": error.code})
    if error.code == NOTE_VERSION_CONFLICT:
        return HTTPException(status_code=NOTE_CONFLICT_STATUS, detail={"code": error.code})
    if error.code in {NOTE_BODY_REQUIRED, NOTE_TITLE_REQUIRED}:
        return HTTPException(status_code=NOTE_INVALID_STATUS, detail={"code": error.code})
    return HTTPException(status_code=400, detail={"code": error.code})


def fetch_arxiv_fulltext(item_id: str, pdf_indexes: Any = None) -> LiteratureItem:
    """Download the identifier's primary PDF and attach it; product and bridge share this.

    只有主附件才是全文: 补充材料 (role=supplementary) 不算, 主附件行还在但字节
    已丢 (availability=missing) 时也要允许重新获取。判据与挂载都由附件域 owner
    ``attach_primary_pdf`` 持有 (产品上传腿与 bridge 的 fulltext-attach 共用同一份),
    这里只负责「先判再下载」: 已有可用主附件时提前 409, 不白跑一次外呼。
    ``pdf_indexes`` 用于补挂时连带忘掉那条不可用旧行派生的全文索引。
    """

    repository = LiteratureRepository()
    item = repository.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
    if has_usable_primary(item_id, repository):
        raise _primary_conflict(ARXIV_ALREADY_ATTACHED)
    try:
        fulltext = fetch_identifier_pdf(item)
    except (ArxivDownloadError, FulltextDownloadError) as error:
        # 获取失败各有确定状态 (404 没找到 / 403 有但不给 / 429 限流 / 504 超时); 落到默认
        # 分支的只可能是前置校验问题 (标识无效、缺标识), 一律 400。
        status = OUTCOME_STATUS.get(error.code, PRECONDITION_STATUS)
        raise HTTPException(
            status_code=status,
            detail={
                "code": error.code,
                "message": FULLTEXT_ERROR_MESSAGES[error.code],
            },
        ) from error
    identifier = fulltext.arxiv or fulltext.doi or item_id
    display_name = f"{identifier.replace('/', '_')}{PDF_SUFFIX}"
    try:
        attached = attach_primary_pdf(
            item,
            display_name,
            fulltext.content,
            repository=repository,
            pdf_indexes=pdf_indexes,
            # 下载顺带确认的标识要与附件行同一个批次落库。
            items=(
                replace(
                    item,
                    arxiv=fulltext.arxiv or item.arxiv,
                    doi=fulltext.doi or item.doi,
                    updated_at=datetime.now(UTC).timestamp(),
                ),
            ),
        )
    except AttachmentConflictError as error:
        # 下载期间另一个入口挂上了主附件: 与提前判据同一个码, 只是晚了一步。
        raise _primary_conflict(error.code) from error
    return attached.item


def purge_literatures(identifiers: tuple[str, ...], pdf_indexes: Any) -> list[str]:
    """Delete items with their exclusive bytes and derived indexes; one entry point."""

    repository = LiteratureRepository()
    deleted: list[str] = []
    for identifier in identifiers:
        files = repository.attachment_files(identifier)
        removed, _projects = repository.delete(identifier, True)
        if removed:
            # 附件随文献走: 行删掉之后, 它独占的文件与它派生的全文索引一起清。
            delete_attachments(tuple(path for path, _revision in files))
            forget_removed_indexes(pdf_indexes, tuple(revision for _path, revision in files))
            deleted.append(identifier)
    return deleted


def purge_attachment(item_id: str, attachment_id: str, pdf_indexes: Any) -> str | None:
    """Remove one attachment row plus its exclusive bytes and derived index."""

    repository = LiteratureRepository()
    deleted = repository.delete_attachment(item_id, attachment_id)
    if deleted is None:
        return None
    delete_attachments((deleted.path,))
    forget_removed_indexes(pdf_indexes, (deleted.revision,))
    return attachment_id


def _export_payload(
    repository: LiteratureRepository, identifiers: tuple[str, ...]
) -> dict[str, Any]:
    """把一批 id 导出成 BibTeX; 超过单批上限直接报错, 绝不静默裁剪。

    ``count`` 是「成功导出 N 条文献」的唯一依据, 必须是真正写进文本的条目数;
    ``missing`` 如实报告请求里查不到的 id (通常已被别处删除), 调用方才能对得上账。
    """

    requested = tuple(dict.fromkeys(identifiers))
    if len(requested) > MAX_BATCH_RECORDS:
        raise HTTPException(
            status_code=EXPORT_LIMIT_STATUS,
            detail={
                "code": EXPORT_TOO_MANY_ITEMS,
                "message": EXPORT_TOO_MANY_MESSAGE,
                "max": MAX_BATCH_RECORDS,
                "requested": len(requested),
            },
        )
    entries = repository.by_ids(requested)
    return {
        "bibtex": to_bibtex(entries),
        "count": len(entries),
        "requested": len(requested),
        "missing": len(requested) - len(entries),
    }


def register_global_routes(app: FastAPI) -> None:
    """Register the catalogue API consumed by the refactored Desktop feature."""

    # 仓储层用领域异常表达「库文件不可用」, 不由每个路由各自转 HTTP; 在这里统一
    # 兜住, 泄漏出来的 LiteratureError 才有稳定状态码而不是 500。
    @app.exception_handler(LiteratureError)
    async def literature_error(request: Request, error: LiteratureError) -> JSONResponse:
        return JSONResponse(
            status_code=(
                LIBRARY_CONFLICT_STATUS
                if error.code in {LIBRARY_INVALID, IMPORT_CONFLICT}
                else LIBRARY_UNAVAILABLE_STATUS
            ),
            content={"detail": error.code},
        )

    tasks: dict[str, dict[str, Any]] = {}
    #: Zotero 导入意图 → 还在跑的任务 id。路由是同步的、跑在线程池里, 两个并发
    #: 点击都能各自通过检查, 所以查改必须在同一把锁下完成。
    zotero_imports: dict[str, str] = {}
    zotero_imports_lock = threading.Lock()

    @app.post(f"{API_PREFIX}/literatures/{{literature_id}}/papercard")
    async def import_papercard(literature_id: str, request: Request) -> dict:
        repository = LiteratureRepository()
        item = repository.get(literature_id)
        if item is None:
            raise HTTPException(404, LITERATURE_NOT_FOUND)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > CARD_MAX_BYTES:
                raise HTTPException(413, "papercard_too_large")
        try:
            bundle = json.loads(raw)
            if not isinstance(bundle, dict):
                raise ValueError("papercard_invalid")
            # The caller associates an evidence bundle with an existing literature
            # identity. Coordinates from external bundles are never trusted.
            card = PaperCards(repository.database).save(literature_id, bundle, "import")
        except (ValueError, RecursionError) as error:
            raise HTTPException(400, str(error)) from error
        return {
            "literature_id": literature_id,
            "revision": card["revision"],
            "sentence_count": len(card["sentences"]),
            "invalid_fields": card["invalid_fields"],
        }

    @app.get(f"{API_PREFIX}/literatures")
    def list_literatures(
        request: Request,
        q: str = "",
        collection_id: list[str] = Query(default=[]),
        tag_id: list[str] = Query(default=[]),
        project_id: str = "",
        without_collection: bool = False,
        without_project: bool = False,
        recent: bool = False,
        sort: str = "created_at",
        order: str = "desc",
        page: int = DEFAULT_PAGE,
        page_size: int = DEFAULT_PAGE_SIZE,
        download_session_id: str = "",
        download_run: str = "",
        exclude_paper_id: list[str] = Query(default=[]),
    ) -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        batch_ids = None
        if download_session_id or download_run or exclude_paper_id:
            if not download_session_id or not download_run:
                raise HTTPException(HTTP_400_BAD_REQUEST, DOWNLOAD_RECEIPT_INVALID)
            catalog = getattr(request.app.state, "session_catalog", None)
            if catalog is None:
                raise HTTPException(HTTP_503_SERVICE_UNAVAILABLE, DOWNLOAD_ADMISSION_UNAVAILABLE)
            try:
                catalog.require(download_session_id, SessionPrincipal(request_owner_id(request)))
            except SessionAccessError as exc:
                raise HTTPException(HTTP_404_NOT_FOUND, DOWNLOAD_RECEIPT_INVALID) from exc
            batch_ids = download_literature_ids(
                download_session_id, download_run, project_id, tuple(exclude_paper_id)
            )
        repository = LiteratureRepository()
        size = min(max(page_size, 1), MAX_PAGE_SIZE)
        current = max(page, DEFAULT_PAGE)
        collection_ids = tuple(collection_id)
        tag_ids = tuple(tag_id)
        items = repository.list(
            q=q.strip(),
            project_id=project_id,
            collection_ids=collection_ids,
            tag_ids=tag_ids,
            without_collection=without_collection,
            without_project=without_project,
            recent_only=recent,
            sort=sort,
            order=order,
            limit=size,
            offset=(current - 1) * size,
            ids=batch_ids,
        )
        project_names = _project_names(request)
        return {
            "items": _summaries(items, repository, project_names, project_id),
            "page": current,
            "page_size": size,
            "total": repository.filtered_total(
                ids=batch_ids,
                q=q.strip(),
                project_id=project_id,
                collection_ids=collection_ids,
                tag_ids=tag_ids,
                without_collection=without_collection,
                without_project=without_project,
                recent_only=recent,
            ),
            "next_cursor": str(current + 1) if len(items) == size else None,
        }

    @app.get(f"{API_PREFIX}/literatures/counts")
    def counts(request: Request, project_id: str = "") -> dict[str, int]:
        project_id = _project_scope(request, project_id)
        return counts_payload(LiteratureRepository(), project_id)

    @app.get(f"{API_PREFIX}/literatures/facets")
    def facets(request: Request, project_id: str = "") -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        return facets_payload(LiteratureRepository(), project_id)

    @app.get(f"{API_PREFIX}/literatures/tag-facets")
    def tag_facets(
        request: Request,
        collection_id: list[str] = Query(default=[]),
        project_id: str = "",
        without_collection: bool = False,
        without_project: bool = False,
        recent: bool = False,
    ) -> dict[str, Any]:
        """侧栏标签云的 facet: 全库标签都回, 计数按当前分类作用域收敛并降序排。

        与 /literatures/facets 分开而不是给它加参数, 是因为那一份的 collections 同时
        喂着侧栏分类树 —— 一旦按分类收窄, 返回的 collections 只剩选中子树, 整棵树会
        当场塌掉。打标签用的全量标签列表仍然走 /literatures/facets。

        刻意不接受 tag_id: 交集筛选下被选中的维度不能过滤自己的 facet。
        """

        project_id = _project_scope(request, project_id)
        return tag_facets_payload(
            LiteratureRepository(),
            project_id=project_id,
            collection_ids=tuple(collection_id),
            without_collection=without_collection,
            without_project=without_project,
            recent_only=recent,
        )

    @app.get(f"{API_PREFIX}/literatures/projects")
    def projects(request: Request) -> dict[str, Any]:
        return projects_payload(getattr(request.app.state, "content", None), LiteratureRepository())

    @app.get(f"{API_PREFIX}/literatures/{{item_id}}")
    def detail(item_id: str, request: Request, project_id: str = "") -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        repository = LiteratureRepository()
        item = next(
            (entry for entry in repository.view(project_id).items if entry.id == item_id),
            None,
        )
        if item is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        return _detail(item, repository, _project_names(request), project_id)

    @app.patch(f"{API_PREFIX}/literatures/{{item_id}}")
    def update_literature(
        item_id: str, payload: dict[str, Any], request: Request, project_id: str = ""
    ) -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        raw_fields = payload.get("fields") or {}
        if not isinstance(raw_fields, dict) or set(raw_fields) - EDITABLE_FIELDS:
            raise HTTPException(status_code=400, detail={"code": LIBRARY_INVALID})
        fields = {key: value for key, value in raw_fields.items()}
        if "year" in fields:
            year = fields["year"]
            if year in ("", None):
                fields["year"] = None
            elif type(year) is not int:
                raise HTTPException(status_code=400, detail={"code": LIBRARY_INVALID})
        for key, value in fields.items():
            if key != "year" and not isinstance(value, str):
                raise HTTPException(status_code=400, detail={"code": LIBRARY_INVALID})
        if "bib_type" in payload:
            try:
                fields["bib_type"] = PublicationType(str(payload["bib_type"])).value
            except ValueError as error:
                raise HTTPException(status_code=400, detail={"code": LIBRARY_INVALID}) from error
        collection_ids = payload.get("collection_ids")
        tag_ids = payload.get("tag_ids")
        project_ids = payload.get("project_ids")
        project_collection_ids = payload.get("project_collection_ids")
        for identifiers in (collection_ids, tag_ids, project_ids, project_collection_ids):
            if identifiers is not None and (
                not isinstance(identifiers, list)
                or any(not isinstance(value, str) for value in identifiers)
            ):
                raise HTTPException(status_code=400, detail={"code": LIBRARY_INVALID})
        repository = LiteratureRepository()
        try:
            if project_ids is not None:
                valid_projects = set(_project_names(request))
                if set(project_ids) - valid_projects:
                    raise LiteratureError(LIBRARY_INVALID)
                repository.replace_projects(item_id, tuple(project_ids))
            if project_collection_ids is not None:
                repository.replace_project_collections(
                    item_id, project_id, tuple(project_collection_ids)
                )
            item = repository.update(
                item_id,
                fields,
                tuple(collection_ids) if collection_ids is not None else None,
                tuple(tag_ids) if tag_ids is not None else None,
            )
        except LiteratureError as error:
            raise HTTPException(status_code=400, detail={"code": error.code}) from error
        if item is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        return _detail(item, repository, _project_names(request), project_id)

    @app.post(f"{API_PREFIX}/literatures/{{item_id}}/attachments/arxiv")
    def download_arxiv_attachment(item_id: str, request: Request) -> dict[str, Any]:
        saved = fetch_arxiv_fulltext(item_id, _pdf_indexes(request))
        return _detail(saved, LiteratureRepository(), _project_names(request))

    @app.post(f"{API_PREFIX}/literatures/{{item_id}}/attachments", status_code=201)
    async def upload_attachment(
        item_id: str, request: Request, primary: bool = Query(default=False)
    ) -> dict[str, Any]:
        repository = LiteratureRepository()
        item = repository.get(item_id)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        form = await request.form()
        upload = form.get(PDF_FIELD)
        if not isinstance(upload, UploadFile) or not upload.filename:
            raise _pdf_error(400, PDF_FILE_REQUIRED)
        try:
            content, _ = await _upload_bytes(upload, 0)
            try:
                attachment_format = upload_format(
                    upload.filename,
                    content,
                    upload.content_type or "",
                )
            except AttachmentFormatError as error:
                raise _attachment_error(422, error.code) from error
            if primary and attachment_format.media_type != PDF_MEDIA_TYPE:
                raise _pdf_error(400, PDF_INVALID)
        finally:
            await upload.close()
        if primary:
            # 主附件走附件域 owner: 与 bridge 的 literature/fulltext-attach 共用同一条
            # 不变式 —— 已有可用主附件就 409, 不留替换开关; 旧行不可用 (字节丢了) 才
            # 允许补挂, 且旧行连带独占字节与派生索引一起清掉, 不降级成 missing 补充材料。
            try:
                attached = attach_primary_pdf(
                    item,
                    upload.filename or ATTACHMENT_FALLBACK_NAME,
                    content,
                    declared_media_type=upload.content_type or "",
                    pdf_indexes=_pdf_indexes(request),
                    repository=repository,
                )
            except AttachmentConflictError as error:
                raise _primary_conflict(error.code) from error
            except AttachmentFormatError as error:
                raise _attachment_error(422, error.code) from error
            return attached.attachment
        suffix = PurePath(upload.filename or "").suffix[:16]
        published = managed_object(item_id, content, suffix)
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            path = batch.stage(published.name, content)
            attachment = batch.commit_operation(
                lambda: repository.add_attachment(
                    item_id,
                    upload.filename or ATTACHMENT_FALLBACK_NAME,
                    path,
                    attachment_format.kind,
                    revision=published.revision,
                    role=AttachmentRole.SUPPLEMENTARY,
                    media_type=attachment_format.media_type,
                )
            )
        return attachment

    @app.get(f"{API_PREFIX}/collections")
    def collections(request: Request, project_id: str = "") -> list[dict[str, Any]]:
        return [
            _facet(entry)
            for entry in LiteratureRepository().collections(_project_scope(request, project_id))
        ]

    @app.post(f"{API_PREFIX}/collections", status_code=201)
    def create_collection(payload: dict[str, Any], request: Request) -> dict[str, Any]:
        project_id = _project_scope(request, str(payload.get("project_id") or ""))
        try:
            return LiteratureRepository().create_collection(
                str(payload.get("name", "")),
                payload.get("parent_id") or payload.get("parent") or None,
                project_id,
            )
        except LiteratureError as error:
            raise HTTPException(status_code=400, detail={"code": error.code}) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(
                status_code=409,
                detail={"code": "COLLECTION_NAME_EXISTS", "message": "同级分组名称已存在"},
            ) from error

    @app.patch(f"{API_PREFIX}/collections/{{collection_id}}")
    def update_collection(
        collection_id: str, payload: dict[str, Any], request: Request, project_id: str = ""
    ) -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        try:
            return LiteratureRepository().update_collection(collection_id, payload, project_id)
        except LiteratureError as error:
            raise HTTPException(status_code=400, detail={"code": error.code}) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(
                status_code=409,
                detail={"code": "COLLECTION_NAME_EXISTS", "message": "同级分组名称已存在"},
            ) from error

    @app.delete(f"{API_PREFIX}/collections/{{collection_id}}")
    def delete_collection(
        collection_id: str, request: Request, project_id: str = ""
    ) -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        result = LiteratureRepository().delete_collection(collection_id, project_id)
        if not result["collections"]:
            raise HTTPException(status_code=404, detail={"code": "COLLECTION_NOT_FOUND"})
        return {"deleted": collection_id, **result}

    @app.get(f"{API_PREFIX}/tags")
    def tags() -> list[dict[str, Any]]:
        return [_tag_facet(entry) for entry in LiteratureRepository().tags()]

    @app.post(f"{API_PREFIX}/tags", status_code=201)
    def create_tag(payload: dict[str, Any]) -> dict[str, Any]:
        return LiteratureRepository().create_tag(str(payload.get("name", "")))

    @app.delete(f"{API_PREFIX}/tags/{{tag_id}}")
    def delete_tag(tag_id: str) -> dict[str, Any]:
        result = LiteratureRepository().delete_tag(tag_id)
        if not result["tags"]:
            raise HTTPException(status_code=404, detail={"code": "TAG_NOT_FOUND"})
        return {"deleted": tag_id, **result}

    @app.post(f"{API_PREFIX}/literatures/bulk")
    def bulk(payload: dict[str, Any], request: Request) -> dict[str, Any]:
        identifiers = tuple(str(value) for value in payload.get("literature_ids", ()))
        operation = str(payload.get("operation", ""))
        parameters = payload.get("parameters") or {}
        repository = LiteratureRepository()
        failed: tuple[str, ...] = ()
        if operation in {BULK_ADD_TAGS, BULK_REMOVE_TAGS}:
            tags = tuple(str(tag) for tag in parameters.get("tags", ()))
            action = TAXONOMY_ADD if operation == BULK_ADD_TAGS else TAXONOMY_REMOVE
            identifiers, missing = repository.organize_tags(identifiers, tags, action)
            failed = missing
        elif operation in {
            BULK_LINK_PROJECT,
            BULK_UNLINK_PROJECT,
            "add_collections",
            "add_tags_by_id",
        }:
            requested_project = str(parameters.get("project_id") or "")
            collection_ids = tuple(str(value) for value in parameters.get("collection_ids", ()))
            if operation in {BULK_LINK_PROJECT, BULK_UNLINK_PROJECT} and not requested_project:
                raise HTTPException(
                    status_code=400,
                    detail={"code": PROJECT_REQUIRED, "message": "请选择要加入的项目"},
                )
            project_id = _project_scope(request, requested_project) if requested_project else ""
            if operation == BULK_LINK_PROJECT:
                identifiers, failed = repository.link_project(
                    identifiers, project_id, collection_ids
                )
            elif operation == BULK_UNLINK_PROJECT:
                identifiers = repository.unlink_project(identifiers, project_id)
            else:
                identifiers = repository.associate(
                    identifiers,
                    project_id=project_id,
                    collection_ids=collection_ids,
                    tag_ids=tuple(str(value) for value in parameters.get("tag_ids", ())),
                )
        elif operation != BULK_MARK_READ:
            raise HTTPException(status_code=400, detail={"code": INVALID_BULK_OPERATION})
        return {
            "succeeded": list(identifiers),
            "failed": [{"id": identifier, "code": LITERATURE_NOT_FOUND} for identifier in failed],
        }

    @app.post(f"{API_PREFIX}/literatures/bulk-delete")
    def bulk_delete(payload: dict[str, Any], request: Request) -> dict[str, Any]:
        identifiers = tuple(str(value) for value in payload.get("literature_ids", ()))
        return {"deleted": purge_literatures(identifiers, _pdf_indexes(request))}

    @app.get(f"{API_PREFIX}/literatures/{{item_id}}/notes")
    def list_notes(item_id: str) -> dict[str, Any]:
        notes = LiteratureRepository().notes(item_id)
        if notes is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        return {"items": [_note_payload(note) for note in notes]}

    @app.post(f"{API_PREFIX}/literatures/{{item_id}}/notes", status_code=201)
    def add_note(item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        repository = LiteratureRepository()
        try:
            note = repository.create_note(
                item_id,
                str(payload.get("text", "")),
                str(payload.get("title", "")),
            )
        except LiteratureError as error:
            raise _note_error(error) from error
        return _note_payload(note)

    @app.patch(f"{API_PREFIX}/literatures/{{item_id}}/notes/{{note_id}}")
    def update_note(item_id: str, note_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        expected_version = payload.get("version")
        if type(expected_version) is not int or expected_version < 1:
            raise HTTPException(status_code=NOTE_INVALID_STATUS, detail={"code": LIBRARY_INVALID})
        try:
            note = LiteratureRepository().update_note(
                item_id,
                note_id,
                title=str(payload.get("title", "")),
                text=str(payload.get("text", "")),
                expected_version=expected_version,
            )
        except LiteratureError as error:
            raise _note_error(error) from error
        return _note_payload(note)

    @app.delete(f"{API_PREFIX}/literatures/{{item_id}}/notes/{{note_id}}")
    def delete_note(item_id: str, note_id: str) -> dict[str, Any]:
        if not LiteratureRepository().delete_note(item_id, note_id):
            raise HTTPException(status_code=404, detail={"code": NOTE_NOT_FOUND})
        return {"deleted": note_id}

    @app.delete(f"{API_PREFIX}/literatures/{{item_id}}/attachments/{{attachment_id}}")
    def delete_attachment(item_id: str, attachment_id: str, request: Request) -> dict[str, Any]:
        deleted = purge_attachment(item_id, attachment_id, _pdf_indexes(request))
        if deleted is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        return {"deleted": deleted}

    @app.post(f"{API_PREFIX}/imports", status_code=202)
    def create_import(
        payload: dict[str, Any],
        request: Request,
        idempotency_key: str | None = Header(default=None, alias=IDEMPOTENCY_KEY_HEADER),
    ) -> dict[str, Any]:
        identifier = str(uuid4())
        source = str(payload.get("source", ""))
        raw_options = payload.get("options")
        options: dict[str, Any] = raw_options if isinstance(raw_options, dict) else {}
        identity = ""
        if source == ZOTERO_SOURCE:
            scoped_project = _project_scope(request, str(options.get("project_id") or ""))
            options = {
                **options,
                "project_id": scoped_project,
                # 落点在受理时就校验: 导入跑在后台线程里, 那里抛错只能变成一条
                # 失败任务, 调用方拿不到「分类不可用」这个真实原因。
                "collection_id": _import_collection(
                    scoped_project, str(options.get("collection_id") or "")
                ),
            }
            # 调用方给了幂等键就用它 (一次导入意图一个键, 重试复用); 没给就退回按
            # 受理参数取指纹, 让不带键的调用方也不会把同一批文献导两遍。
            identity = (idempotency_key or "").strip() or _zotero_import_identity(options)
        task: dict[str, Any] = {
            "id": identifier,
            "kind": IMPORT_KIND,
            "status": RUNNING if source == ZOTERO_SOURCE else TERMINAL_FAILED,
            "progress": 0.0,
            "completed_count": 0,
            "total_count": 0,
            "error": None if source == ZOTERO_SOURCE else f"unsupported_import_source:{source}",
            "error_code": None if source == ZOTERO_SOURCE else UNSUPPORTED_IMPORT_SOURCE,
        }
        with zotero_imports_lock:
            if identity:
                finished = [
                    key
                    for key, task_id in zotero_imports.items()
                    if tasks.get(task_id, {}).get("status") != RUNNING
                ]
                for key in finished:
                    del zotero_imports[key]
                running = tasks.get(zotero_imports.get(identity, ""))
                if running is not None:
                    # 同一份受理参数的导入还在跑: 交回同一个任务, 不再起第二个后台
                    # 线程 —— 文献是追加语义, 第二次执行就是第二份条目。
                    return running
                zotero_imports[identity] = identifier
            tasks[identifier] = task
        if source == ZOTERO_SOURCE:

            def progress(completed: int, total: int) -> None:
                task.update(
                    progress=completed / total if total else 0.0,
                    completed_count=completed,
                    total_count=total,
                )

            def run() -> None:
                try:
                    raw_selection = options.get("selection", ())
                    selection = tuple(
                        (str(entry.get("key", "")), bool(entry.get("selected")))
                        for entry in raw_selection
                        if isinstance(entry, dict) and entry.get("key")
                    )
                    selected_keys = options.get("selected_collection_keys")
                    result = import_zotero(
                        progress,
                        project_id=str(options.get("project_id") or ""),
                        target_collection_id=str(options.get("collection_id") or ""),
                        selected_collection_keys=(
                            tuple(str(key) for key in selected_keys)
                            if isinstance(selected_keys, list)
                            else None
                        ),
                        selection=selection,
                        include_unfiled=bool(options.get("include_unfiled", True)),
                        import_collections=bool(options.get("import_collections", True)),
                        preview_revision=str(options.get("preview_revision") or ""),
                    )
                    task.update(
                        status=TERMINAL_COMPLETED,
                        progress=1.0,
                        completed_count=len(result.items),
                        total_count=len(result.items),
                        imported_count=len(result.items),
                        imported_ids=[item.id for item in result.items],
                        copied_pdf_count=result.pdfs,
                        imported_collection_count=result.collections,
                    )
                except ZoteroImportError as error:
                    task.update(
                        status=TERMINAL_FAILED,
                        error=ZOTERO_ERROR_MESSAGES.get(error.code, "Zotero 导入失败"),
                        error_code=error.code,
                    )
                except Exception:
                    LOGGER.exception("Unexpected Zotero import failure")
                    task.update(
                        status=TERMINAL_FAILED,
                        error="Zotero 导入失败",
                        error_code=ZOTERO_IMPORT_FAILED,
                    )

            threading.Thread(target=run, daemon=True, name=f"zotero-import-{identifier}").start()
        return task

    @app.get(f"{API_PREFIX}/imports/zotero/preview")
    def zotero_preview() -> dict[str, Any]:
        try:
            return asdict(preview_zotero())
        except ZoteroImportError as error:
            raise _zotero_error(503, error.code) from error

    @app.post(f"{API_PREFIX}/imports/pdf", status_code=201)
    async def import_pdf(
        request: Request, project_id: str = "", collection_id: str = ""
    ) -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        collection_id = _import_collection(project_id, collection_id)
        form = await request.form()
        upload = form.get(PDF_FIELD)
        if not isinstance(upload, UploadFile) or not upload.filename:
            raise _pdf_error(400, PDF_FILE_REQUIRED)
        try:
            content = bytearray()
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                content.extend(chunk)
                if len(content) > MAX_IMPORT_BYTES:
                    raise _pdf_error(413, PDF_TOO_LARGE)
            try:
                metadata = extract_pdf_metadata(bytes(content))
            except InvalidPdfError as error:
                raise _pdf_error(400, PDF_INVALID) from error
        finally:
            await upload.close()
        # 同一份 PDF 再导一次就是一条新文献（proposal 91），也各存一份自己的字节:
        # 文件名带上新条目自己的 id, 删除任何一条都不会动到另一条的全文。
        admitted = LiteratureItem(
            id=new_item_id(),
            title=metadata.title.strip() or PurePath(upload.filename).stem,
            authors=metadata.author.strip(),
            arxiv=metadata.arxiv,
            doi=metadata.doi,
        )
        published = managed_object(admitted.id, bytes(content), PDF_SUFFIX)
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            path = batch.stage(published.name, bytes(content))
            repository = LiteratureRepository()

            def attach(values: tuple[LiteratureItem, ...]) -> tuple[LiteratureItem, ...]:
                try:
                    saved = repository.save_all(
                        values, collection_id=collection_id, project_id=project_id
                    )
                except LiteratureError as error:
                    raise HTTPException(
                        status_code=400,
                        detail={"code": error.code, "message": IMPORT_COLLECTION_MESSAGE},
                    ) from error
                # 同 arXiv 分支: 附件行与文件搬运要么一起成, 要么一起回滚。
                repository.add_attachment(
                    saved[0].id,
                    upload.filename or ATTACHMENT_FALLBACK_NAME,
                    path,
                    PDF_KIND,
                    revision=published.revision,
                    role=AttachmentRole.PRIMARY,
                    media_type=PDF_MEDIA_TYPE,
                )
                return saved

            item = batch.commit((admitted,), attach)[0]
        return _summary(item, LiteratureRepository(), {})

    @app.post(f"{API_PREFIX}/imports/bibliography", status_code=201)
    async def import_bibliography(
        request: Request,
        collection_id: str = Query(default=""),
        project_id: str = Query(default=""),
    ) -> dict[str, Any]:
        project_id = _project_scope(request, project_id)
        form = await request.form()
        uploads = [
            value
            for key, value in form.multi_items()
            if key == BIBLIOGRAPHY_FIELD and isinstance(value, UploadFile) and value.filename
        ]
        if not uploads:
            raise _bibliography_error(400, BIBLIOGRAPHY_FILE_REQUIRED)
        total = 0
        items: list[LiteratureItem] = []
        try:
            for upload in uploads:
                payload, total = await _upload_bytes(upload, total)
                outcome = parse_import(upload.filename or "", payload)
                if outcome.skipped:
                    raise _bibliography_error(422, BIBLIOGRAPHY_ENTRY_INCOMPLETE)
                items.extend(outcome.items)
        except LiteratureImportError as error:
            raise _bibliography_error(422, BIBLIOGRAPHY_INVALID) from error
        finally:
            for upload in uploads:
                await upload.close()
        repository = LiteratureRepository()
        # 每次导入都是追加：不探测既存条目、不合并（proposal 91）。
        try:
            imported = repository.save_all(
                tuple(items),
                collection_id=collection_id,
                project_id=project_id,
            )
        except LiteratureError as error:
            raise HTTPException(
                status_code=400,
                detail={"code": error.code, "message": IMPORT_COLLECTION_MESSAGE},
            ) from error
        return {
            "items": _summaries(imported, repository, {}),
            "count": len(imported),
        }

    @app.post(f"{API_PREFIX}/imports/identifier", status_code=201)
    async def import_identifier(payload: dict[str, Any], request: Request) -> dict[str, Any]:
        """按一行 arXiv ID / DOI 建一条题录。

        两条腿都是既有通路: 解析腿 ``service.bibliography`` 取回上游 BibTeX 原文,
        落库腿把原文交给与 bib/ris 文件导入完全相同的 ``parse_import`` + ``save_all``,
        所以准入、字段归一化与追加语义 (不判重, proposal 91) 天然一致。维度由
        ``detect_kind`` 在服务端判定, 前端不复制标识符正则。
        """

        identifier = str(payload.get(IDENTIFIER_FIELD) or "").strip()
        if not identifier:
            raise _identifier_error(400, IDENTIFIER_REQUIRED)
        # 落点与文件导入同一套受理期校验: 分类不可用要立刻 400, 而不是落库时才炸。
        project_id = _project_scope(request, str(payload.get(PROJECT_FIELD) or ""))
        collection_id = _import_collection(project_id, str(payload.get(COLLECTION_FIELD) or ""))
        try:
            text = await fetch_identifier_bibliography(
                identifier, timeout=resolve_timeout_seconds()
            )
        except BibliographyError as error:
            raise _identifier_error(error.status, error.code) from error
        try:
            outcome = parse_import(IDENTIFIER_BIBLIOGRAPHY_NAME, text.encode("utf-8"))
        except LiteratureImportError as error:
            raise _identifier_error(422, IDENTIFIER_ENTRY_INCOMPLETE) from error
        repository = LiteratureRepository()
        try:
            imported = repository.save_all(
                outcome.items, collection_id=collection_id, project_id=project_id
            )
        except LiteratureError as error:
            raise HTTPException(
                status_code=400,
                detail={"code": error.code, "message": IMPORT_COLLECTION_MESSAGE},
            ) from error
        return _summary(imported[0], repository, {})

    @app.get(f"{API_PREFIX}/tasks/{{task_id}}")
    def task(task_id: str) -> dict[str, Any]:
        current = tasks.get(task_id)
        if current is None:
            raise HTTPException(status_code=404, detail={"code": TASK_NOT_FOUND})
        return current

    @app.post(f"{API_PREFIX}/exports")
    def export(payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("format", BIBTEX_FORMAT) != BIBTEX_FORMAT:
            raise HTTPException(status_code=400, detail={"code": UNSUPPORTED_EXPORT_FORMAT})
        identifiers = tuple(str(value) for value in payload.get("literature_ids", ()))
        return _export_payload(LiteratureRepository(), identifiers)


__all__ = [
    "API_PREFIX",
    "LIBRARY_CONFLICT_STATUS",
    "LIBRARY_UNAVAILABLE_STATUS",
    "register_global_routes",
]
