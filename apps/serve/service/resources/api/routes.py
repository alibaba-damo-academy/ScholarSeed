"""资料库 HTTP 路由 (resources 域, 开发 2 拥有)。

架构文档 §3.2: 本域负责资料目录、列表、筛选、导入、本地搜索与 Agent 产物。
**文件操作全部委托 `ContentPort`**(开发 1) —— 本文件不出现 `Path` 拼接,
也不做越界校验, 那是 content 域唯一的职责。

路由前缀保持 `/api/resource` 不变: 改前缀会同时打断前端调用与已有验收
harness, 而目录/所有权对齐并不要求 URL 也跟着改。URL 是对外契约,
目录是内部组织, 两者没有必须一致的理由。
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request, Response
from pydantic import ValidationError

from service.content.domain.model import ContentError
from service.content.service.port import DEFAULT_MEDIA_TYPE, ContentService
from service.content.service.tree import DEFAULT_MAX_DEPTH
from service.platform.activity import ActivityDomain
from service.platform.content import (
    AssetKind,
    AssetOrigin,
    AssetPage,
    AssetTree,
    ExternalRootRef,
    RootKind,
)
from service.platform.excerpts import ExcerptSourceError
from service.platform.resources import ResourceCapability
from service.resources.api.schema import ResourceExcerptsRequest, ResourceImportRequest
from service.resources.api.web import WEB_CANDIDATE_URL_LIMIT, WebImportRequest
from service.resources.domain.model import (
    PdfExcerptSelection,
    ResourceImportDecision,
    ResourceLocationRef,
)
from service.resources.persistence.catalog import (
    ResourceAgentImportCatalog,
    ResourceWebSourceCatalog,
)
from service.resources.persistence.listing import ResourceListingCatalog, ResourceSource
from service.resources.service.excerpts import (
    EXCERPT_TOO_LARGE,
    ResourceExcerptError,
    ResourceExcerptService,
)
from service.resources.service.fetcher import PageFetchError, SiteIconFetcher
from service.resources.service.history import ResourceVersionError
from service.resources.service.importer import (
    ResourceImportError,
    ResourceImportService,
    ResourceImportStatus,
    WebCandidate,
    WebImporter,
    WebImportItem,
    WebImportStatus,
)
from service.resources.service.listing import ResourceListing
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.writer import ResourceWriterError

#: 资料库路由前缀。
RESOURCE_ROUTE_PREFIX = "/api/resource"
RESOURCE_CANDIDATE_PAGE_SIZE = 200

#: 请求不合法时的状态码 (与既有网关约定一致)。
INVALID_REQUEST_STATUS = 400

#: 领域错误码 → HTTP 状态码。
#:
#: 集中一张表而不在每个处理器里判断: 新增错误码只需加一行,
#: 且同一个码在所有端点上语义一致。
ERROR_STATUS = {
    "path_outside_project": 400,
    "invalid_name": 400,
    "name_too_long": 400,
    "bad_mode": 400,
    "bad_action": 400,
    "no_project_selected": 400,
    "unknown_project": 404,
    "file_not_found": 404,
    "node_not_found": 404,
    "source_not_found": 404,
    "target_not_found": 404,
    "parent_not_found": 404,
    "authorized_root_unavailable": 403,
    "parent_not_writable": 403,
    "not_text_file": 415,
    "file_too_large": 413,
    "excerpt_too_large": 413,
    "literature_not_found": 404,
    "literature_pdf_missing": 404,
    "literature_revision_conflict": 409,
    "invalid_excerpt_resource": 409,
    "ambiguous_excerpt_resource": 409,
    "revision_conflict": 409,
    "import_plan_stale": 409,
    "import_decisions_invalid": 400,
    "import_background_required": 409,
    "replace_not_supported": 409,
    "idempotency_key_required": 400,
    "idempotency_conflict": 409,
    "name_exists": 409,
}

SELECTIONS_REQUIRED = "selections_required"
INVALID_PAGE = "invalid_page"
INVALID_LOCATOR = "invalid_locator"
INVALID_EXCERPT = "invalid_excerpt"
RESOURCE_EXCERPTS_UNAVAILABLE = "resource_excerpts_unavailable"
RESOURCE_AGENT_IMPORTS_UNAVAILABLE = "resource_agent_imports_unavailable"
RESOURCE_WEB_SOURCES_UNAVAILABLE = "resource_web_sources_unavailable"
RESOURCE_WEB_ORIGIN_NOT_FOUND = "resource_web_origin_not_found"
PATH_SEPARATOR = "/"
IDEMPOTENCY_HEADER = "idempotency-key"
WEB_ICON_CACHE_SECONDS = 86_400
WEB_ICON_CACHE_CONTROL = f"private, max-age={WEB_ICON_CACHE_SECONDS}"
WEB_ICON_CROSS_ORIGIN_RESOURCE_POLICY = "cross-origin"
WEB_ICON_SERVICE_UNAVAILABLE = "web_icon_unavailable"
WEB_ICON_UNAVAILABLE_STATUS = 404
WEB_ICON_RESPONSE_HEADERS = {
    "Cache-Control": WEB_ICON_CACHE_CONTROL,
    "Content-Disposition": "inline",
    "Cross-Origin-Resource-Policy": WEB_ICON_CROSS_ORIGIN_RESOURCE_POLICY,
    "X-Content-Type-Options": "nosniff",
}


def _content(request: Request) -> ContentService:
    """从应用状态取 content 域服务。

    由 bootstrap 统一注入; 本域不自行构造 —— 架构文档 §2.1 要求
    「不在各业务域中自行构造其他域的 Service」。
    """

    service = getattr(request.app.state, "content", None)
    if service is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    return service


def _web_importer(request: Request) -> WebImporter:
    """从组合根取得唯一的受限网页入库服务。"""

    service = getattr(request.app.state, "web_importer", None)
    if not isinstance(service, WebImporter):
        raise HTTPException(status_code=503, detail="web_import_unavailable")
    return service


def _web_icon_fetcher(request: Request) -> SiteIconFetcher:
    """Return the composition-owned guarded network fetcher for site icons."""

    service = getattr(request.app.state, "web_icon_fetcher", None)
    if not isinstance(service, SiteIconFetcher):
        raise HTTPException(status_code=503, detail=WEB_ICON_SERVICE_UNAVAILABLE)
    return service


def _resource_importer(request: Request) -> ResourceImportService:
    """Return the single resources-owned local import coordinator."""

    service = getattr(request.app.state, "resource_importer", None)
    if not isinstance(service, ResourceImportService):
        raise HTTPException(status_code=503, detail="resource_import_unavailable")
    return service


def _schedule_version_scan(request: Request, project_id: str) -> None:
    supervisor = getattr(request.app.state, "resource_version_supervisor", None)
    if supervisor is not None:
        supervisor.schedule_scan(project_id)


def _fail(error: ContentError) -> HTTPException:
    """领域错误 → HTTP。错误码原样透出, 前端按码分支。"""

    return _fail_code(error.code)


def _fail_code(code: str) -> HTTPException:
    """稳定业务错误码 → HTTP，用于 resources 域自身的编排错误。"""

    return HTTPException(
        status_code=ERROR_STATUS.get(code, INVALID_REQUEST_STATUS),
        detail=code,
    )


def _excerpts(request: Request) -> ResourceExcerptService:
    """取组合根注入的来源摘录→资料编排服务。"""

    service = getattr(request.app.state, "resource_excerpts", None)
    if not isinstance(service, ResourceExcerptService):
        raise HTTPException(status_code=503, detail=RESOURCE_EXCERPTS_UNAVAILABLE)
    return service


def _agent_imports(request: Request) -> ResourceAgentImportCatalog:
    """Return the project-local Agent import provenance catalogue."""

    catalog = getattr(request.app.state, "resource_agent_imports", None)
    if not isinstance(catalog, ResourceAgentImportCatalog):
        raise HTTPException(status_code=503, detail=RESOURCE_AGENT_IMPORTS_UNAVAILABLE)
    return catalog


def _web_sources(request: Request) -> ResourceWebSourceCatalog:
    """Return the project-local Web provenance catalogue."""

    catalog = getattr(request.app.state, "resource_web_sources", None)
    if not isinstance(catalog, ResourceWebSourceCatalog):
        raise HTTPException(status_code=503, detail=RESOURCE_WEB_SOURCES_UNAVAILABLE)
    return catalog


def _excerpt_validation(error: ValidationError) -> HTTPException:
    """把 Pydantic 细节收敛成稳定的资料库错误码。"""

    locations = [tuple(str(part) for part in issue["loc"]) for issue in error.errors()]
    if any(location == ("selections",) for location in locations):
        code = SELECTIONS_REQUIRED
    elif any("page" in location for location in locations):
        code = INVALID_PAGE
    elif any("quads" in location or "locator" in location for location in locations):
        code = INVALID_LOCATOR
    elif any(
        "text" in location and issue["type"] == "string_too_long"
        for location, issue in zip(locations, error.errors())
    ):
        code = EXCERPT_TOO_LARGE
    else:
        code = INVALID_EXCERPT
    return HTTPException(status_code=ERROR_STATUS.get(code, INVALID_REQUEST_STATUS), detail=code)


def _tree_paths(nodes: tuple[AssetTree, ...], *, files_only: bool = True) -> tuple[str, ...]:
    paths: list[str] = []
    pending = list(nodes)
    while pending:
        node = pending.pop()
        if not files_only or node.asset.kind is AssetKind.FILE:
            paths.append(node.asset.path)
        pending.extend(node.children)
    return tuple(paths)


def _tree_payload(
    node: AssetTree,
    capabilities: dict[str, ResourceCapability] | None = None,
    roots: tuple[ExternalRootRef, ...] = (),
    repositories: dict[str, str | None] | None = None,
) -> dict:
    """资料树节点的线上形状。

    仍回 `path/name/kind/children`: 这是前端已消费的形状, 契约不变。

    `count` 是该目录条目的**总数**而非本次返回的条数: 前端拿它跟 `children`
    的长度一比就知道还有没有没投影出来的条目 —— 不管是深度上限没往下扫, 还是
    单层分页只取了前一页。两个上限都是取数分页而非可见性上限, 「还有多少」必须
    交出去; 只回一页却报一页的数, 就是静默丢弃。

    `origin` 让 UI 分辨副本与关联原文件 —— LINK 节点的改名/同根移动作用在用户
    项目外的真实文件上，删除入口只撤销关联；不标出来用户无从判断自己在动什么。
    关联根不可用时 `available=false`, 挂载点撞真实同名目录时 `conflict=true`:
    两者都必须明示, 否则「关联失效」看起来就是个空目录。
    """

    children = [_tree_payload(child, capabilities, roots, repositories) for child in node.children]
    payload: dict = {
        "path": node.asset.path,
        "name": node.asset.name,
        "kind": node.asset.kind.value,
        "origin": node.asset.origin.value,
        "updated_at": node.updated_at,
    }
    if not node.available:
        payload["available"] = False
    if node.conflict:
        payload["conflict"] = True
    if node.asset.origin is AssetOrigin.LINK:
        linked_root = next(
            (
                root
                for root in sorted(
                    roots, key=lambda candidate: len(candidate.mount_path), reverse=True
                )
                if node.asset.path == root.mount_path
                or node.asset.path.startswith(f"{root.mount_path}{PATH_SEPARATOR}")
            ),
            None,
        )
        if linked_root is not None:
            payload["link_root_id"] = linked_root.root_id
    if node.asset.kind is AssetKind.DIR:
        if repositories is not None and repositories.get(node.asset.path) == node.asset.path:
            payload["git_repository"] = True
        payload["count"] = node.child_total or None
        payload["children"] = children
    elif capabilities is not None and node.asset.path in capabilities:
        capability = capabilities[node.asset.path]
        payload["version"] = _capability_payload(capability)
    return payload


def _capability_payload(capability: ResourceCapability) -> dict:
    return {
        "management_state": capability.management_state.value,
        "manual_admitted": capability.manual_admitted,
        "drifted": capability.drifted,
        "snapshot_state": capability.snapshot_state.value if capability.managed else None,
        "pending_origin": capability.pending.origin.value if capability.pending else None,
        "needs_review": capability.pending.needs_review if capability.pending else False,
    }


def _asset_payload(asset) -> dict:
    """单个资产的线上形状。"""

    return {
        "path": asset.path,
        "name": asset.name,
        "kind": asset.kind.value,
        "origin": asset.origin.value,
        "asset_id": asset.asset_id,
    }


def _web_item_payload(item: WebImportItem) -> dict:
    """单条网页入库结果的稳定线上形状。"""

    payload: dict = {
        "title": item.title,
        "url": item.url,
        "status": item.status.value,
    }
    if item.final_url:
        payload["final_url"] = item.final_url
    if item.node:
        payload["node"] = _asset_payload(item.node)
    if item.error:
        payload["error"] = item.error
    return payload


def _in_resources_root(content, project: str, path: str) -> str:
    """把「资料树里的位置」翻译成相对项目根的路径。

    资料树的根是**资料库根**, 用户在树根上新建时前端给的是空串; 而 `ContentPort`
    的路径一律相对**项目根** —— 空串在那里是项目根。不翻译的话, MANAGED 项目在
    树根新建的目录会落到 `resources/` 外面, 界面上直接看不见 (LEGACY 项目两个根重合,
    所以这个坑只在内置双库布局下暴露)。
    """

    return content.within_root(project, RootKind.RESOURCES, path)


def _scan_resource_tree(
    content: ContentService,
    project: str,
    path: str,
    depth: int,
    offset: int,
) -> tuple[AssetPage, str, str, tuple[ExternalRootRef, ...], dict[str, str | None]]:
    page = (
        content.subtree(
            project,
            _in_resources_root(content, project, path),
            depth=depth,
            offset=offset,
        )
        if path
        else content.tree(project, depth=depth, offset=offset)
    )
    root = content.project(project).root
    resource_root = content.root_relative(project, RootKind.RESOURCES)
    linked_roots = content.external_roots(project)
    repositories = content.repository_roots(project, _tree_paths(page.children, files_only=False))
    return page, root, resource_root, linked_roots, repositories


def _resource_listing(
    content: ContentService, project: str, supervisor: ResourceVersionSupervisor | None
) -> dict:
    """Materialize the whole disk-backed list away from the HTTP event loop."""

    entries = ResourceListing(content).list(project)
    linked_roots = content.external_roots(project)
    paths = tuple(entry.path for entry in entries)
    repositories = content.repository_roots(project, paths)
    capabilities = (
        supervisor.capability_states(project, paths, repositories=repositories)
        if supervisor is not None
        else {}
    )
    return {
        "items": [
            {
                **asdict(entry),
                "git_repository": repositories.get(entry.path) == entry.path,
                **(
                    {"version": _capability_payload(capabilities[entry.path])}
                    if entry.path in capabilities
                    else {}
                ),
                "link_root_id": next(
                    (
                        root.root_id
                        for root in linked_roots
                        if entry.path == root.mount_path
                        or entry.path.startswith(f"{root.mount_path}/")
                    ),
                    None,
                ),
            }
            for entry in entries
        ],
        "linked_roots": {
            root.root_id: {
                "root_id": root.root_id,
                "mount_path": root.mount_path,
                "source_path": root.source_path,
            }
            for root in linked_roots
        },
    }


def register_resource_routes(app: FastAPI) -> None:
    """把资料库路由挂到应用上。"""

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/list")
    async def resource_list(request: Request, project: str = Query(min_length=1)) -> dict:
        try:
            content = _content(request)
            supervisor = getattr(request.app.state, "resource_version_supervisor", None)
            if supervisor is not None:
                await supervisor.activate_project(project)
            return await request.app.state.activities.to_thread(
                ActivityDomain.RESOURCE, _resource_listing, content, project, supervisor
            )
        except ContentError as exc:
            raise _fail(exc) from exc

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/agent-origin")
    def resource_agent_origin(
        request: Request,
        project: str = Query(min_length=1),
        path: str = Query(min_length=1),
    ) -> dict | None:
        """Return optional Agent provenance; an ordinary resource has no such origin."""

        try:
            _content(request).project(project)
            record = _agent_imports(request).get(project, path)
        except ContentError as exc:
            raise _fail(exc) from exc
        if record is None:
            return None
        return {
            "source_kind": record.source_kind.value,
            "session_id": record.source_session_id,
            "session_deleted": request.app.state.session_catalog.get(record.source_session_id)
            is None,
            "turn_id": record.source_turn_id,
            "item_id": record.source_item_id,
            "source_range": (record.source_detail or {}).get("range"),
        }

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/web-origin")
    def resource_web_origin(
        request: Request,
        project: str = Query(min_length=1),
        path: str = Query(min_length=1),
    ) -> dict:
        """Return durable fetch provenance for an imported Web resource."""

        try:
            _content(request).project(project)
            record = _web_sources(request).get(project, path)
        except ContentError as exc:
            raise _fail(exc) from exc
        if record is None:
            raise HTTPException(status_code=404, detail=RESOURCE_WEB_ORIGIN_NOT_FOUND)
        return {
            "web_source_id": record.web_source_id,
            "resource_revision": record.resource_revision,
            "source_title": record.source_title,
            "source_url": record.source_url,
            "final_url": record.final_url,
            "search_query": record.search_query,
            "fetched_at": record.fetched_at,
            "schema_version": record.schema_version,
        }

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/tree")
    async def resource_tree(  # type: ignore[unused-ignore]
        request: Request,
        project: str | None = Query(default=None),
        path: str = Query(default=""),
        depth: int = Query(default=DEFAULT_MAX_DEPTH, ge=1, le=8),
        offset: int = Query(default=0, ge=0),
    ) -> dict:
        """资料树浏览 (PRD「资料树浏览」)。

        `path` 为空扫资料库根; 给了目录就从那里续扫。`offset` 取同一层的下一页 ——
        树一次只回 `depth` 层、每层一页, 更深的层级与更多的条目都由前端带
        `path`/`offset` 回来取, 而不是把整棵盘一次拍平。

        顶层的 `total`/`offset` 说明**这一层**共有多少条、本页从哪开始: 顶层没有
        父节点能承载这个数, 不放在响应顶层就没地方放, 而没有它前端无从知道
        「还有下一页」。
        """

        content = _content(request)
        supervisor = getattr(request.app.state, "resource_version_supervisor", None)
        try:
            if supervisor is not None:
                await supervisor.activate_project(project or "")
            page, root, resource_root, linked_roots, repositories = await asyncio.to_thread(
                _scan_resource_tree,
                content,
                project or "",
                path,
                depth,
                offset,
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        capability_paths = _tree_paths(page.children)
        capabilities = (
            supervisor.capability_states(
                project or "",
                capability_paths,
                repositories={path: repositories[path] for path in capability_paths},
            )
            if supervisor is not None
            else None
        )
        return {
            "root": root,
            "resource_root": resource_root,
            "nodes": [
                _tree_payload(node, capabilities, linked_roots, repositories)
                for node in page.children
            ],
            "linked_roots": {
                linked_root.root_id: {
                    "root_id": linked_root.root_id,
                    "mount_path": linked_root.mount_path,
                    "source_path": linked_root.source_path,
                }
                for linked_root in linked_roots
            },
            "total": page.total,
            "offset": page.offset,
        }

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/candidates")
    def resource_candidates(  # type: ignore[unused-ignore]
        request: Request,
        project: str | None = Query(default=None),
        cursor: str | None = Query(default=None),
    ) -> dict:
        """Complete filename candidates for compact cross-feature pickers."""

        try:
            page = _content(request).enumerate_resources(
                project or "",
                cursor,
                RESOURCE_CANDIDATE_PAGE_SIZE,
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        return {
            "items": [asdict(entry) for entry in page.entries],
            "next_cursor": page.next_cursor,
        }

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/count")
    async def resource_count(  # type: ignore[unused-ignore]
        request: Request,
        project: str | None = Query(default=None),
    ) -> dict:
        """资料文件总数 (项目卡上的「资料」计数)。

        口径是资料树的**完整枚举**, 不是树投影的条数: `/tree` 带深度与单层分页
        两个上限, 拿它数出来的是「这一页看见多少」, 而不是「有多少」。
        `scan_resources` 的契约正是「每个已授权逻辑资料文件恰好一次」—— 只数文件、
        按逻辑路径去重、含关联外部根, 与资料库面板看到的集合同源。

        枚举是阻塞的整树遍历, 放 `to_thread`: 首页会为每个项目各发一次, 直接在
        事件循环里跑会把这些请求串成一条队。
        """

        content = _content(request)
        try:
            resolved = content.project(project)
            entries = await asyncio.to_thread(content.scan_resources, resolved.id)
        except ContentError as exc:
            raise _fail(exc) from exc
        return {"project": resolved.id, "files": len(entries)}

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/read")
    async def resource_read(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
    ) -> dict:
        """读取文本资料内容, 供 Markdown 双视图使用。"""

        try:
            return {
                "path": path,
                "content": _content(request).read_text(project or "", path),
            }
        except ContentError as exc:
            raise _fail(exc) from exc

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/raw")
    async def resource_raw(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
    ) -> Response:
        """按字节返回项目内文件 (图片预览用)。

        PDF 也可经此取字节, 但 PDF 的打开协议归 workbench 域 (架构文档 §3.4);
        本端点只作通用字节通道, 不含任何 PDF 专属逻辑。
        """

        try:
            payload, media = _content(request).read_bytes(project or "", path)
        except ContentError as exc:
            raise _fail(exc) from exc
        return Response(
            content=payload,
            media_type=media or DEFAULT_MEDIA_TYPE,
            # inline 让 Chromium 直接内嵌渲染而不是弹下载。
            headers={"Content-Disposition": "inline"},
        )

    @app.post(f"{RESOURCE_ROUTE_PREFIX}/write")
    async def resource_write(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """保存文本资料 (PRD「源码编辑视图」「渲染编辑视图」的落盘)。"""

        path = str(payload.get("path", ""))
        if not path:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="path_required")
        # 先把 Port 绑到局部名再写: 「写文件只能经 Port」这条边界要在源码形态上
        # 一眼可辨 (边界 guard 按接收者判定 write_text 是 Port 调用还是直接写磁盘)。
        content = _content(request)
        try:
            content.write_text(
                str(payload.get("project") or ""), path, str(payload.get("content", ""))
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        _schedule_version_scan(request, str(payload.get("project") or ""))
        return {"path": path, "saved": True}

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/search")
    def resource_search(  # type: ignore[unused-ignore]
        request: Request,
        q: str = Query(...),
        project: str | None = Query(default=None),
    ) -> dict:
        """资料搜索 (PRD「资料搜索」: 文件名或关键词)。"""

        try:
            found = _content(request).search(project or "", q)
        except ContentError as exc:
            raise _fail(exc) from exc
        return {
            "query": q,
            "hits": [asdict(hit) for hit in found.hits],
            "truncated": found.truncated,
        }

    @app.post(f"{RESOURCE_ROUTE_PREFIX}/import")
    async def resource_import(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """Preflight and execute local import through one two-phase endpoint."""

        try:
            body = ResourceImportRequest.model_validate(payload)
        except ValidationError as exc:
            raise _fail_code("import_decisions_invalid") from exc
        try:
            content = _content(request)
            project_id = content.project(body.project or None).id
            target_dir = _in_resources_root(content, project_id, body.target_dir)
            outcome = _resource_importer(request).import_sources(
                project_id,
                body.mode,
                tuple(body.sources),
                target_dir,
                plan_token=body.plan_token,
                decisions=tuple(
                    ResourceImportDecision(item.source_index, item.action)
                    for item in body.decisions
                ),
                idempotency_key=request.headers.get(IDEMPOTENCY_HEADER),
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        except (ResourceImportError, ResourceVersionError) as exc:
            raise _fail_code(exc.code) from exc
        if outcome.status is ResourceImportStatus.NEEDS_RESOLUTION:
            return {
                "status": outcome.status.value,
                "mode": outcome.mode.value,
                "plan_token": outcome.plan_token,
                "conflicts": [
                    {
                        "source_index": item.source_index,
                        "source_name": item.source_name,
                        "source_kind": item.source_kind.value,
                        "target_path": item.target_path,
                        "target_kind": (
                            item.target_kind.value if item.target_kind is not None else None
                        ),
                        "suggested_name": item.suggested_name,
                        "expected_target_revision": item.expected_target_revision,
                        "can_replace_with_version": item.can_replace_with_version,
                    }
                    for item in outcome.conflicts
                ],
            }
        _schedule_version_scan(request, project_id)
        return {
            "status": outcome.status.value,
            "mode": outcome.mode.value,
            "project_id": project_id,
            "imported": [_asset_payload(asset) for asset in outcome.imported],
        }

    @app.post(f"{RESOURCE_ROUTE_PREFIX}/web-import")
    def resource_web_import(  # type: ignore[unused-ignore]
        request: Request,
        body: WebImportRequest,
    ) -> dict:
        """把选中候选以「标题 + URL」引用资料写入项目资料库（默认不抓取整页）。"""

        content = _content(request)
        try:
            # 项目错误必须在任何出站请求前失败，避免无有效落点时仍抓取网页。
            content.project(body.project)
        except ContentError as exc:
            raise _fail(exc) from exc
        try:
            items = _web_importer(request).import_candidates(
                body.project,
                body.query,
                body.parent,
                tuple(
                    WebCandidate(
                        title=candidate.title,
                        url=candidate.url,
                        snippet=candidate.snippet,
                    )
                    for candidate in body.candidates
                ),
            )
        except ResourceWriterError as exc:
            raise _fail_code(exc.code) from exc
        succeeded = sum(item.status is WebImportStatus.SUCCESS for item in items)
        return {
            "succeeded": succeeded,
            "failed": len(items) - succeeded,
            "items": [_web_item_payload(item) for item in items],
        }

    @app.get(f"{RESOURCE_ROUTE_PREFIX}/web-icon")
    async def resource_web_icon(  # type: ignore[unused-ignore]
        request: Request,
        url: str = Query(..., min_length=1, max_length=WEB_CANDIDATE_URL_LIMIT),
    ) -> Response:
        """Proxy one bounded public favicon without exposing remote URLs to the renderer."""

        try:
            icon = await asyncio.to_thread(_web_icon_fetcher(request).fetch_site_icon, url)
        except PageFetchError as error:
            raise HTTPException(
                status_code=WEB_ICON_UNAVAILABLE_STATUS,
                detail=error.code,
            ) from error
        return Response(
            content=icon.content,
            media_type=icon.media_type,
            headers=WEB_ICON_RESPONSE_HEADERS,
        )

    @app.post(f"{RESOURCE_ROUTE_PREFIX}/excerpts")
    async def resource_excerpts(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """把一篇文献的多段 PDF 选区聚合为一份可溯源 Markdown 资料。"""

        try:
            body = ResourceExcerptsRequest.model_validate(payload)
        except ValidationError as error:
            raise _excerpt_validation(error) from error
        selections = tuple(
            PdfExcerptSelection(
                text=selection.text,
                page=selection.locator.page,
                quads=tuple(selection.locator.quads),
            )
            for selection in body.selections
        )
        try:
            outcome = _excerpts(request).add(
                project_id=body.project,
                source_kind=body.source.kind,
                source_id=body.source.literature_id,
                expected_document_revision=body.source.document_revision,
                location=ResourceLocationRef(
                    parent=body.location.parent,
                    name=body.location.name or "",
                ),
                selections=selections,
            )
        except (ExcerptSourceError, ResourceExcerptError) as error:
            raise HTTPException(
                status_code=ERROR_STATUS.get(error.code, INVALID_REQUEST_STATUS),
                detail=error.code,
            ) from error
        return {
            "operation": outcome.operation.value,
            "node": {
                "path": outcome.asset_path,
                "name": outcome.asset_name,
                "kind": AssetKind.FILE.value,
                "origin": AssetOrigin.LOCAL.value,
            },
            "literature_id": outcome.source_id,
            "added": outcome.added,
            "skipped": outcome.skipped,
            "total": outcome.total,
        }

    @app.post(f"{RESOURCE_ROUTE_PREFIX}/node")
    async def resource_node(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """新建/重命名/移动/复制 (PRD「资料新建」「资料管理」)。

        单端点 + action 判别式: 五个动作共享项目解析与错误映射。
        """

        content = _content(request)
        action = str(payload.get("action", ""))
        project = str(payload.get("project") or "")
        path = str(payload.get("path", ""))
        name = str(payload.get("name", ""))
        raw_parent = str(payload.get("parent", ""))
        raw_target = payload.get("target_dir")

        try:
            parent = _in_resources_root(content, project, raw_parent)
            target_dir = (
                None
                if raw_target is None
                else _in_resources_root(content, project, str(raw_target))
            )
            if action == "create_document":
                if "content" in payload:
                    asset = content.create_text(project, parent, name, str(payload["content"]))
                else:
                    asset = content.create(project, parent, name, AssetKind.FILE)
            elif action == "create_folder":
                asset = content.create(project, parent, name, AssetKind.DIR)
            elif action == "rename":
                asset = content.rename(project, path, name)
            elif action == "move":
                asset = content.move(project, path, target_dir or "")
            elif action == "copy":
                asset = await asyncio.to_thread(content.copy, project, path, target_dir)
            else:
                raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="bad_action")
        except ContentError as exc:
            raise _fail(exc) from exc
        listing = ResourceListingCatalog(content)
        if action in {"create_document", "create_folder"}:
            listing.record(project, (asset,), ResourceSource.CREATED)
        elif action in {"rename", "move", "copy"}:
            listing.relocate(project, path, asset.path, copy=action == "copy")
        _schedule_version_scan(request, project)
        return {"action": action, "node": _asset_payload(asset)}

    @app.post(f"{RESOURCE_ROUTE_PREFIX}/reveal")
    async def resource_reveal(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict = Body(...),
    ) -> dict:
        """在访达中打开 (PRD「在访达中打开」)。

        后端把项目内相对路径解析为经校验的绝对路径, 由 Electron 主进程
        调 `shell.showItemInFolder` 真正打开 —— 渲染进程不自行拼路径。
        """

        try:
            absolute = _content(request).resolve(
                str(payload.get("project") or ""), str(payload.get("path", ""))
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        if not Path(absolute).exists():
            raise HTTPException(status_code=404, detail="node_not_found")
        return {"absolute": absolute}


__all__ = ["RESOURCE_ROUTE_PREFIX", "register_resource_routes"]
