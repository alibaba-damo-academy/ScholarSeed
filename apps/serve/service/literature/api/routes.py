"""文献库 HTTP 路由。

使用方式 (参考 identity/workbench 的注册模式)::

    from fastapi import FastAPI
    from service.literature.api.routes import register_literature_routes

    app = FastAPI()
    register_literature_routes(app)

调用方也可以通过 ``service`` 参数注入已配置好路径的 ``LiteratureService``。
"""

from __future__ import annotations

from dataclasses import asdict, replace
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from service.content.domain.model import ContentError
from service.literature.domain.model import IMPORT_CONFLICT, LIBRARY_INVALID, LiteratureError
from service.literature.persistence.files import delete_attachments
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.persistence.store import LiteratureRepository, edit_library, load_library
from service.literature.schema import (
    UNFILED_COLLECTION,
    FulltextStatus,
    ImportSource,
    LiteratureCollection,
    LiteratureItem,
    LiteratureNote,
    LiteratureView,
)
from service.literature.service.attachment import forget_removed_indexes
from service.literature.service.catalog import (
    FILTER_ALL,
    BatchAction,
)
from service.literature.service.catalog import ListQuery
from service.literature.service.catalog import ListQuery as CatalogListQuery
from service.literature.service.catalog import (
    PdfFilter,
    SortKey,
    apply_batch,
    apply_query,
    collect_collections,
    collect_fulltext_counts,
    collect_tags,
    collect_years,
    is_recent,
    item_collection,
    to_bibtex,
)
from service.literature.service.importer import LiteratureImportError, import_from_paths
from service.literature.service.library import LIBRARY_RELATIVE_PATH, LiteratureService
from service.platform.citations import PDF_INDEX_STATE

from .catalogue import register_global_routes
from .schema import (
    BatchCollection,
    BatchIds,
    BatchTag,
    BibtexExport,
    BibtexResponse,
    CollectionCreate,
    CollectionOut,
    CollectionRename,
    CountResponse,
    ItemCreate,
    ItemOut,
    ListResponse,
    TagOut,
)

#: 文献库 API 前缀。
LITERATURE_ROUTE_PREFIX = "/api/literature"
_tasks: dict[str, dict] = {}
INVALID_REQUEST_STATUS = 400
NOT_IMPLEMENTED_STATUS = 501
LIBRARY_CONFLICT_STATUS = 409
LIBRARY_UNAVAILABLE_STATUS = 503


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")


def _summary(item: LiteratureItem, repository: LiteratureRepository, project_id: str = "") -> dict:
    tags = repository.tags()
    collections = repository.collections(project_id)
    tag_by_name = {entry["name"]: entry for entry in tags}
    collection_by_name = {entry["name"]: entry for entry in collections}
    return {
        "id": item.id,
        "item_type": item.item_type,
        "bib_type": item.pubtype.value,
        "title": item.title,
        "creators_display": item.authors,
        "publication_display": item.venue or item.journal,
        "year": item.year,
        "published_date": item.published_date or None,
        "created_at": _iso(item.added_at),
        "updated_at": _iso(item.updated_at or item.added_at),
        "last_read_at": None,
        "read_progress": 0.0,
        "is_unread": True,
        "primary_attachment": (
            asdict(primary) if (primary := repository.primary_attachment(item.id)) else None
        ),
        "collections": [
            {
                "id": collection_by_name[name]["id"],
                "name": name,
                "count": collection_by_name[name]["count"],
                "parent_id": collection_by_name[name]["parent_id"],
            }
            for name in item.collections
            if name in collection_by_name
        ],
        "project_collections": (
            [
                {
                    "id": collection_by_name[name]["id"],
                    "name": name,
                    "count": collection_by_name[name]["count"],
                    "parent_id": collection_by_name[name]["parent_id"],
                }
                for name in item.collections
                if name in collection_by_name
            ]
            if project_id
            else []
        ),
        "tags": [
            {
                "id": tag_by_name[name]["id"],
                "name": name,
                "count": tag_by_name[name]["count"],
                "color": tag_by_name[name]["color"] or None,
            }
            for name in item.tags
            if name in tag_by_name
        ],
        "projects": [
            {"id": project_id, "name": project_id} for project_id in repository.projects(item.id)
        ],
        "version": item.version,
    }


def _list_query(
    search: str = "",
    tag: str = FILTER_ALL,
    fulltext: str = FILTER_ALL,
    year: str = FILTER_ALL,
    collection: str = FILTER_ALL,
    recent_only: bool = False,
    pdf: str = FILTER_ALL,
    sort: str = SortKey.ADDED.value,
    descending: bool = False,
) -> CatalogListQuery:
    """把 GET 查询参数组装成 ``CatalogListQuery``。"""

    try:
        sort_key = SortKey(sort)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid_sort: {sort}") from exc
    try:
        pdf_filter = PdfFilter(pdf)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid_pdf: {pdf}") from exc
    return CatalogListQuery(
        search=search,
        tag=tag,
        fulltext=fulltext,
        year=year,
        collection=collection,
        recent_only=recent_only,
        pdf=pdf_filter,
        sort=sort_key,
        descending=descending,
    )


def _parse_fulltext(value: str) -> FulltextStatus:
    """校验并解析全文状态。"""

    try:
        return FulltextStatus(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid_fulltext: {value}") from exc


def _item_to_out(item: LiteratureItem) -> ItemOut:
    """领域模型 → API 输出模型。"""

    return ItemOut(
        id=item.id,
        pubtype=item.pubtype,
        title=item.title,
        author=item.authors,
        authors=item.authors,
        url=item.url,
        venue=item.venue or item.journal,
        journal=item.journal,
        year=item.year,
        pages=item.pages,
        volume=item.volume,
        fulltext=item.fulltext.value,
        tags=list(item.tags),
        abstract=item.abstract,
        doi=item.doi,
        arxiv=item.arxiv,
        publisher=item.publisher,
        address=item.address,
        collection=item.collection,
        added_at=item.added_at,
        notes=[asdict(n) for n in item.notes],
    )


def _item_from_payload(payload: ItemCreate) -> LiteratureItem:
    """API 请求模型 → 领域模型。"""

    return LiteratureItem(
        id=payload.id,
        title=payload.title,
        authors=payload.author or payload.authors,
        journal=payload.venue or payload.journal,
        year=payload.year,
        fulltext=_parse_fulltext(payload.fulltext),
        pubtype=payload.pubtype,
        url=payload.url,
        venue=payload.venue or payload.journal,
        pages=payload.pages,
        volume=payload.volume,
        arxiv=payload.arxiv,
        publisher=payload.publisher,
        address=payload.address,
        tags=tuple(payload.tags),
        abstract=payload.abstract,
        doi=payload.doi,
        collection=payload.collection,
        added_at=payload.added_at,
        notes=tuple(
            LiteratureNote(
                id=n.id,
                text=n.text,
                created_at=n.created_at,
                title=n.title,
                updated_at=n.updated_at,
                version=n.version,
                position=n.position,
            )
            for n in payload.notes
        ),
    )


def _scope(request: Request, project: str | None) -> tuple[Any, str]:
    content = getattr(request.app.state, "content", None)
    if content is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    try:
        return content, content.project(project).id
    except ContentError as exc:
        raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc


def _item_payload(item: LiteratureItem) -> dict:
    payload = asdict(item)
    payload["fulltext"] = item.fulltext.value
    payload["tags"] = list(item.tags)
    payload["collection"] = item_collection(item)
    payload["notes"] = [asdict(note) for note in item.notes]
    return payload


def _find_item(view: LiteratureView, item_id: str) -> LiteratureItem:
    for item in view.items:
        if item.id == item_id:
            return item
    raise HTTPException(status_code=404, detail="item_not_found")


def register_literature_routes(
    app: FastAPI,
    *,
    service: LiteratureService | None = None,
) -> None:
    """把文献库路由挂到 FastAPI 应用上。"""

    register_global_routes(app)

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

    fallback: LiteratureService | None = None
    if service is None:
        fallback = LiteratureService(LIBRARY_RELATIVE_PATH)
        app.state.literature = fallback

    def _svc(request: Request) -> LiteratureService:
        if service is not None:
            return service
        svc = getattr(request.app.state, "literature", None)
        if svc is None:
            svc = fallback or LiteratureService(LIBRARY_RELATIVE_PATH)
            request.app.state.literature = svc
        return svc

    @app.get("/api/v1/literatures")
    def list_global_literatures(
        request: Request,
        q: str = "",
        collection_id: list[str] = Query(default=[]),
        tag_id: list[str] = Query(default=[]),
        project_id: str = "",
        without_collection: bool = False,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """Page through the user-level global fact library."""
        size = min(max(page_size, 1), 200)
        current = max(page, 1)
        repository = LiteratureRepository()
        collection_ids = tuple(collection_id)
        tag_ids = tuple(tag_id)
        items = repository.list(
            q=q.strip(),
            project_id=project_id,
            collection_ids=collection_ids,
            tag_ids=tag_ids,
            without_collection=without_collection,
            limit=size,
            offset=(current - 1) * size,
        )
        return {
            "items": [_summary(item, repository, project_id) for item in items],
            "page": current,
            "page_size": size,
            "total": repository.filtered_total(
                q=q.strip(),
                project_id=project_id,
                collection_ids=collection_ids,
                tag_ids=tag_ids,
                without_collection=without_collection,
            ),
            "next_cursor": str(current + 1) if len(items) == size else None,
        }

    @app.get("/api/v1/literatures/counts")
    def global_counts() -> dict:
        repository = LiteratureRepository()
        items = repository.list()
        return {
            "all": repository.total(),
            "recent": 0,
            "without_collection": sum(not item.collections for item in items),
            "unread": len(items),
            "without_fulltext": sum(item.fulltext is FulltextStatus.NONE for item in items),
        }

    @app.get("/api/v1/literatures/facets")
    def global_facets() -> dict:
        repository = LiteratureRepository()
        items = repository.list()
        years: dict[str, int] = {}
        for item in items:
            if item.year is not None:
                years[str(item.year)] = years.get(str(item.year), 0) + 1
        item_types: dict[str, int] = {}
        publications: dict[str, int] = {}
        for item in items:
            item_types[item.item_type] = item_types.get(item.item_type, 0) + 1
            publication = item.venue or item.journal
            if publication:
                publications[publication] = publications.get(publication, 0) + 1
        return {
            "years": [{"value": int(value), "count": count} for value, count in years.items()],
            "tags": repository.tags(),
            "collections": repository.collections(),
            "item_types": [
                {"id": name, "name": name, "count": count} for name, count in item_types.items()
            ],
            "publications": [
                {"id": name, "name": name, "count": count} for name, count in publications.items()
            ],
        }

    @app.get("/api/v1/literatures/{item_id}")
    def global_detail(item_id: str) -> dict:
        item = LiteratureRepository().get(item_id)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "LITERATURE_NOT_FOUND"})
        repository = LiteratureRepository()
        counts = AttachmentRecordCatalog(repository.database).annotation_counts(item_id)
        return {
            **_summary(item, repository),
            "citation_key": item.citation_key or None,
            "abstract": item.abstract or None,
            "doi": item.doi or None,
            "isbn": item.isbn or None,
            "issn": None,
            "url": item.url or None,
            "volume": item.volume or None,
            "number": item.number or None,
            "pages": item.pages or None,
            "publisher": item.publisher or None,
            "attachment_count": len(repository.attachments(item.id)),
            "note_count": len(item.notes),
            "annotation_count": sum(counts.values()),
        }

    @app.delete("/api/v1/literatures/{item_id}")
    def global_delete(item_id: str, request: Request, confirm_referenced: bool = False) -> dict:
        repository = LiteratureRepository()
        files = repository.attachment_files(item_id)
        removed, projects = repository.delete(item_id, confirm_referenced)
        if not removed:
            raise HTTPException(status_code=404, detail={"code": "LITERATURE_NOT_FOUND"})
        # 附件随文献走: 行已经在仓储事务里级联删掉, 这里收它独占的物理文件, 以及
        # 由这批字节派生的全文索引缓存 (revision 只能趁行还在的时候取走)。
        delete_attachments(tuple(path for path, _revision in files))
        forget_removed_indexes(
            getattr(request.app.state, PDF_INDEX_STATE, None),
            tuple(revision for _path, revision in files),
        )
        return {"deleted": item_id}

    @app.get("/api/v1/collections")
    def global_collections(project_id: str = "") -> list[dict]:
        return LiteratureRepository().collections(project_id)

    @app.post("/api/v1/collections", status_code=201)
    def global_create_collection(payload: CollectionCreate, request: Request) -> dict:
        project_id = payload.project_id
        if project_id:
            _, project_id = _scope(request, project_id)
        return LiteratureRepository().create_collection(
            payload.name, payload.parent or None, project_id
        )

    @app.delete("/api/v1/collections/{collection_id}")
    def global_delete_collection(collection_id: str, project_id: str = "") -> dict:
        LiteratureRepository().delete_collection(collection_id, project_id)
        return {"deleted": collection_id}

    @app.get("/api/v1/tags")
    def global_tags() -> list[dict]:
        return LiteratureRepository().tags()

    @app.post("/api/v1/tags", status_code=201)
    def global_create_tag(payload: CollectionCreate) -> dict:
        return LiteratureRepository().create_tag(payload.name)

    @app.post("/api/v1/literatures/bulk")
    def global_bulk(payload: dict) -> dict:
        identifiers = tuple(str(value) for value in payload.get("literature_ids", ()))
        operation = str(payload.get("operation", ""))
        parameters = payload.get("parameters", {})
        literature = LiteratureService()
        if operation == "add_tags":
            for tag in parameters.get("tags", ()):
                literature.add_tag(identifiers, str(tag))
        elif operation == "remove_tags":
            for tag in parameters.get("tags", ()):
                literature.remove_tag(identifiers, str(tag))
        elif operation == "mark_read":
            pass
        else:
            raise HTTPException(status_code=400, detail={"code": "INVALID_BULK_OPERATION"})
        return {"succeeded": list(identifiers), "failed": []}

    @app.post("/api/v1/exports/bibtex", response_model=BibtexResponse)
    def global_export_bibtex(payload: BibtexExport) -> BibtexResponse:
        text = LiteratureService().export_bibtex(tuple(payload.ids))
        return BibtexResponse(bibtex=text, count=len(payload.ids))

    @app.post("/api/v1/literatures/bulk-delete")
    def global_bulk_delete(payload: dict) -> dict:
        repository = LiteratureRepository()
        for identifier in payload.get("literature_ids", ()):
            repository.delete(str(identifier), True)
        return {"deleted": list(payload.get("literature_ids", ()))}

    @app.post("/api/v1/imports", status_code=202)
    def create_import(payload: dict) -> dict:
        identifier = str(uuid4())
        task = {
            "id": identifier,
            "kind": "import",
            "status": "failed",
            "progress": 0.0,
            "completed_count": 0,
            "total_count": 0,
            "error": f"unsupported_import_source:{payload.get('source', '')}",
        }
        _tasks[identifier] = task
        return task

    @app.get("/api/v1/tasks/{task_id}")
    def get_task(task_id: str) -> dict:
        task = _tasks.get(task_id)
        if task is None:
            raise HTTPException(
                status_code=404, detail={"code": "TASK_NOT_FOUND", "message": "任务不存在"}
            )
        return task

    @app.post("/api/v1/exports")
    def global_export(payload: dict) -> dict:
        if payload.get("format", "bibtex") != "bibtex":
            raise HTTPException(
                status_code=400,
                detail={"code": "UNSUPPORTED_EXPORT_FORMAT", "message": "不支持的导出格式"},
            )
        identifiers = tuple(str(value) for value in payload.get("literature_ids", ()))
        bibtex, count = LiteratureService().export_bibtex_counted(identifiers)
        return {"bibtex": bibtex, "count": count}

    @app.get(f"{LITERATURE_ROUTE_PREFIX}/items")
    async def literature_items(  # type: ignore[unused-ignore]
        request: Request,
        project: str | None = Query(default=None),
        search: str = Query(default=""),
        tag: str = Query(default=FILTER_ALL),
        fulltext: str = Query(default=FILTER_ALL),
        year: str = Query(default=FILTER_ALL),
        collection: str = Query(default=FILTER_ALL),
        recent: bool = Query(default=False),
        pdf: str = Query(default=PdfFilter.ALL.value),
        sort: str = Query(default=SortKey.ADDED.value),
        desc: bool = Query(default=False),
    ) -> dict:
        """条目列表 + 侧栏导航维度 (PRD「文献组织」 + 原型侧栏)。

        一次返回列表与全部侧栏计数：侧栏的「全部/最近添加/未整理/分类/标签」
        计数必须基于**未筛选**的全库，否则点一个标签后其他标签计数全变 0，
        用户就无法再切到其他标签。
        """

        content, project_id = _scope(request, project)
        view = load_library(project_id)
        try:
            sort_key = SortKey(sort)
        except ValueError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_sort") from exc
        try:
            pdf_filter = PdfFilter(pdf)
        except ValueError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_pdf") from exc
        visible = apply_query(
            view.items,
            ListQuery(
                search=search,
                tag=tag,
                fulltext=fulltext,
                year=year,
                collection=collection,
                recent_only=recent,
                pdf=pdf_filter,
                sort=sort_key,
                descending=desc,
            ),
        )
        return {
            "items": [_item_payload(item) for item in visible],
            "total": len(view.items),
            "recentTotal": sum(1 for item in view.items if is_recent(item)),
            "collections": [
                asdict(entry) for entry in collect_collections(view.items, view.collections)
            ],
            "tags": [{"name": name, "count": count} for name, count in collect_tags(view.items)],
            "years": list(collect_years(view.items)),
            "fulltextCounts": collect_fulltext_counts(view.items),
        }

    @app.post(f"{LITERATURE_ROUTE_PREFIX}/collection")
    async def literature_collection(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """新建/重命名/删除分类 (原型侧栏「分类」分组的 + 与子分类)。

        删除分类不删文献：里面的条目退回「未整理」收件箱。把分类当成容器删掉
        会连带删掉用户积累的题录，代价太大。
        """

        content, project_id = _scope(request, payload.get("project"))
        action = str(payload.get("action", ""))
        name = str(payload.get("name", "")).strip()
        if not name:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="name_required")
        if name == UNFILED_COLLECTION:
            # 「未整理」是系统收件箱，不得被用户建立/改名/删除。
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="reserved_collection")

        with edit_library(project_id) as edit:
            view = edit.view
            declared = {entry.name: entry for entry in view.collections}

            if action == "create":
                parent = str(payload.get("parent", "")).strip()
                if parent == UNFILED_COLLECTION:
                    parent = ""
                if name in declared or any(item_collection(item) == name for item in view.items):
                    raise HTTPException(
                        status_code=INVALID_REQUEST_STATUS, detail="collection_exists"
                    )
                declared[name] = LiteratureCollection(name=name, count=0, parent=parent)
                updated = LiteratureView(items=view.items, collections=tuple(declared.values()))
            elif action == "rename":
                target = str(payload.get("target", "")).strip()
                if not target or target == UNFILED_COLLECTION:
                    raise HTTPException(
                        status_code=INVALID_REQUEST_STATUS, detail="reserved_collection"
                    )
                if target != name and (
                    target in declared
                    or any(item_collection(item) == target for item in view.items)
                ):
                    raise HTTPException(
                        status_code=INVALID_REQUEST_STATUS, detail="collection_exists"
                    )
                previous = declared.pop(name, LiteratureCollection(name, 0))
                declared[target] = LiteratureCollection(
                    name=target, count=0, parent=previous.parent
                )
                for key, entry in list(declared.items()):
                    if entry.parent == name:
                        declared[key] = replace(entry, parent=target)
                items = tuple(
                    (
                        replace(item, collection=target, collections=(target,))
                        if item_collection(item) == name
                        else item
                    )
                    for item in view.items
                )
                updated = LiteratureView(items=items, collections=tuple(declared.values()))
            elif action == "delete":
                declared.pop(name, None)
                # 子分类提升为顶层，而不是跟着消失。
                for key, entry in list(declared.items()):
                    if entry.parent == name:
                        declared[key] = replace(entry, parent="")
                items = tuple(
                    (
                        replace(item, collection="", collections=())
                        if item_collection(item) == name
                        else item
                    )
                    for item in view.items
                )
                updated = LiteratureView(items=items, collections=tuple(declared.values()))
            else:
                raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_action")
            edit.view = updated
        return {
            "action": action,
            "collections": [
                asdict(entry) for entry in collect_collections(updated.items, updated.collections)
            ],
        }

    @app.post(f"{LITERATURE_ROUTE_PREFIX}/export")
    async def literature_export(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """导出 BibTeX (原型批量条「导出 .bib」)。

        只回文本，不落盘：存到哪里由用户选，后端自作主张写文件只会弄脏项目目录。
        """

        content, project_id = _scope(request, payload.get("project"))
        raw_ids = payload.get("ids", ())
        if not isinstance(raw_ids, (list, tuple)) or not raw_ids:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="ids_required")
        wanted = {str(item) for item in raw_ids}
        view = load_library(project_id)
        chosen = tuple(item for item in view.items if item.id in wanted)
        if not chosen:
            raise HTTPException(status_code=404, detail="item_not_found")
        return {"bibtex": to_bibtex(chosen), "count": len(chosen)}

    @app.post(f"{LITERATURE_ROUTE_PREFIX}/import")
    async def literature_import(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """BIB / RIS / PDF / 资料库标记 入库 (PRD「文献接入」)。"""

        content, project_id = _scope(request, payload.get("project"))
        raw_source = str(payload.get("source", ImportSource.LOCAL_FILE.value))
        try:
            origin = ImportSource(raw_source)
        except ValueError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_source") from exc
        raw_sources = payload.get("sources", ())
        if not isinstance(raw_sources, (list, tuple)):
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="sources_required")

        load_library(project_id)
        try:
            outcome = import_from_paths(
                content,
                project_id,
                tuple(str(item) for item in raw_sources),
                origin,
                payload.get("operation_id"),
            )
        except LiteratureImportError as exc:
            # 未实现的通道回 501, 其余是请求问题回 400。
            status = (
                NOT_IMPLEMENTED_STATUS
                if exc.code == "unsupported_source"
                else INVALID_REQUEST_STATUS
            )
            raise HTTPException(status_code=status, detail=exc.code) from exc

        return {
            "added": outcome.added,
            "skipped": outcome.skipped,
            "total": outcome.total,
            "operation_id": outcome.operation_id,
            "item_ids": list(dict.fromkeys(item.id for item in outcome.items)),
        }

    @app.post(f"{LITERATURE_ROUTE_PREFIX}/batch")
    async def literature_batch(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """批量打标/去标/移除 (PRD「批量操作」)。"""

        content, project_id = _scope(request, payload.get("project"))
        try:
            action = BatchAction(str(payload.get("action", "")))
        except ValueError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_action") from exc
        raw_ids = payload.get("ids", ())
        if not isinstance(raw_ids, (list, tuple)) or not raw_ids:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="ids_required")

        with edit_library(project_id) as edit:
            updated = apply_batch(
                edit.view,
                action,
                tuple(str(item) for item in raw_ids),
                str(payload.get("tag", "")),
                str(payload.get("collection", "")),
            )
            edit.view = updated
        return {"action": action.value, "total": len(updated.items)}

    @app.post(f"{LITERATURE_ROUTE_PREFIX}/fulltext")
    async def literature_fulltext(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """全文获取状态标注 (PRD「文献获取状态标注」)。

        标注状态是真实落盘的; 真正的 OA 下载与机构代理取回需要外部渠道
        凭证, 本期未实现, 传 `fetch=true` 会显式回 501 而不是假下载。
        """

        content, project_id = _scope(request, payload.get("project"))
        if payload.get("fetch"):
            raise HTTPException(
                status_code=NOT_IMPLEMENTED_STATUS,
                detail="fulltext_fetch_pending",
            )
        item_id = str(payload.get("id", ""))
        try:
            status = FulltextStatus(str(payload.get("status", "")))
        except ValueError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_status") from exc

        with edit_library(project_id) as edit:
            view = edit.view
            _find_item(view, item_id)
            items = tuple(
                replace(item, fulltext=status) if item.id == item_id else item
                for item in view.items
            )
            edit.view = LiteratureView(items=items, collections=view.collections)
        return {"id": item_id, "fulltext": status.value}


__all__ = ["LITERATURE_ROUTE_PREFIX", "register_literature_routes"]
