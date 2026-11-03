"""Workbench HTTP 路由 (workbench 域, 开发 4 拥有)。

架构文档 §3.4 归给本域的对外能力:
- 打开协议与能力注册 → `/api/workbench/open`
- PDF Range/ETag 读取通道 → `/api/workbench/pdf`

PDF 通道单列而不复用资料库的 `/raw`: 架构文档把「资料库和文献库共用的
PDF Viewer」明确划给开发 4, 通道与 Viewer 同域才能一起演进 (Range 请求、
ETag 缓存都是 Viewer 的性能需求, 资料库不关心)。

文件字节仍经 `ContentPort` 读取 —— 本域不碰路径拼接与越界校验。
"""

from __future__ import annotations

from dataclasses import asdict, replace
from hashlib import sha256

from fastapi import FastAPI, HTTPException, Query, Request, Response

from service.content.domain.model import PREPARED_CONFLICT, PREPARED_UNAVAILABLE, ContentError
from service.content.service.port import MAX_BYTES, ContentService
from service.content.service.spreadsheet import processor_for
from service.platform.citations import PDF_INDEX_STATE, CitationDocument, PdfIndexPort
from service.platform.ranges import parse_byte_range
from service.platform.resources import ResourceAdmissionPolicy, ResourceManagedCopyPort
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.workbench.domain.model import (
    FILE_TOO_LARGE,
    WORKBENCH_PREVIEW_MAX_BYTES,
    ContentKind,
    DocumentCapabilities,
    ViewerKind,
    WorkbenchFormatPolicy,
    capabilities_for,
    content_kind_for,
    viewer_for,
)
from service.workbench.service.images import (
    OFFICE_IMAGE_MAX_BYTES,
    persist_image,
    release_office_image,
    stage_office_image,
)
from service.workbench.service.records import PdfRecordStore
from service.workbench.service.regions import crop as crop_region
from service.workbench.service.regions import manifest as region_manifest
from service.workbench.service.regions import region as resolve_region

#: Workbench 路由前缀。
WORKBENCH_ROUTE_PREFIX = "/api/workbench"

#: 领域错误码 → HTTP 状态。与 resources 域同一套码表语义。
ERROR_STATUS = {
    "path_outside_project": 400,
    "no_project_selected": 400,
    "unknown_project": 404,
    "file_not_found": 404,
    PREPARED_UNAVAILABLE: 404,
    "file_too_large": 413,
    "invalid_range": 416,
    "revision_conflict": 412,
    "source_revision_conflict": 409,
    PREPARED_CONFLICT: 409,
    "read_failed": 500,
    "write_failed": 500,
    "invalid_annotations": 422,
    "records_uninitialized": 409,
    "records_source_unavailable": 409,
    "record_link_conflict": 409,
}

CONTENT_ROUTE = f"{WORKBENCH_ROUTE_PREFIX}/content"
ANNOTATIONS_ROUTE = f"{WORKBENCH_ROUTE_PREFIX}/assets/{{asset_id}}/pdf/records"
MANAGED_COPY_ROUTE = f"{WORKBENCH_ROUTE_PREFIX}/managed-copy"
OFFICE_IMAGES_ROUTE = f"{WORKBENCH_ROUTE_PREFIX}/office-images"
PDF_REGIONS_ROUTE = f"{WORKBENCH_ROUTE_PREFIX}/pdf/regions"
RANGE_NOT_SATISFIABLE_STATUS = 416
PARTIAL_CONTENT_STATUS = 206
PRECONDITION_REQUIRED_STATUS = 428
NO_CONTENT_STATUS = 204
CONFLICT_STATUS = 409
OCTET_STREAM_MEDIA_TYPE = "application/octet-stream"
IDEMPOTENCY_HEADER = "idempotency-key"
UTF8_ENCODING = "utf-8"
BYTE_INDEPENDENT_VIEWERS = frozenset((ViewerKind.PDF, ViewerKind.IMAGE, ViewerKind.OFFICE))


def _etag(revision: str) -> str:
    return f'"{revision}"'


def _expected_revision(value: str | None) -> str:
    if value is None:
        raise HTTPException(
            status_code=PRECONDITION_REQUIRED_STATUS,
            detail="revision_required",
        )
    candidate = value.strip()
    if candidate.startswith("W/"):
        raise HTTPException(status_code=412, detail="revision_conflict")
    if len(candidate) >= 2 and candidate[0] == '"' and candidate[-1] == '"':
        candidate = candidate[1:-1]
    if not candidate:
        raise HTTPException(
            status_code=PRECONDITION_REQUIRED_STATUS,
            detail="revision_required",
        )
    return candidate


def _content(request: Request) -> ContentService:
    """取 content 域服务。由 bootstrap 注入, 本域不自行构造。"""

    service = getattr(request.app.state, "content", None)
    if service is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    return service


def _records(request: Request) -> PdfRecordStore:
    service = getattr(request.app.state, "pdf_records", None)
    if service is None:
        raise HTTPException(status_code=503, detail="records_unavailable")
    return service


def _pdf_indexes(request: Request) -> PdfIndexPort:
    service = getattr(request.app.state, PDF_INDEX_STATE, None)
    if service is None:
        raise HTTPException(status_code=503, detail="pdf_index_unavailable")
    return service


def _versions(request: Request) -> ResourceVersionService:
    service = getattr(request.app.state, "resource_versions", None)
    if service is None:
        raise HTTPException(status_code=503, detail="resource_versions_unavailable")
    return service


def _managed_copies(request: Request) -> ResourceManagedCopyPort:
    service = getattr(request.app.state, "resource_version_supervisor", None)
    if service is None:
        raise HTTPException(status_code=503, detail="resource_versions_unavailable")
    return service


def _fail(error: ContentError | ResourceVersionError) -> HTTPException:
    return HTTPException(status_code=ERROR_STATUS.get(error.code, 400), detail=error.code)


def register_workbench_routes(app: FastAPI) -> None:
    """把 Workbench 路由挂到应用上。"""

    @app.get(f"{WORKBENCH_ROUTE_PREFIX}/open")
    async def workbench_open(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
    ) -> dict:
        """打开协议: 回报该文件用哪个 Viewer、支持哪些能力。

        前端据此渲染, **不再按扩展名判断** (架构文档 §4.3)。
        """

        content = _content(request)
        try:
            # 越界、存在性与 exact revision 先由 content 域裁决，再谈能力。
            snapshot = content.snapshot(project or "", path)
        except ContentError as exc:
            raise _fail(exc) from exc
        versioning = None
        if snapshot.size > WORKBENCH_PREVIEW_MAX_BYTES:
            source_bytes = None
            content_kind = ContentKind.OVERSIZED
            viewer = ViewerKind.UNSUPPORTED
            capabilities = DocumentCapabilities(
                can_edit=False,
                can_version=False,
                can_diff=False,
                can_preview=False,
                pending=(FILE_TOO_LARGE,),
            )
        else:
            registered_viewer = viewer_for(path)
            if snapshot.size > MAX_BYTES and registered_viewer in BYTE_INDEPENDENT_VIEWERS:
                source_bytes = None
                content_kind = ContentKind.BINARY
                viewer = registered_viewer
                capabilities = capabilities_for(path)
            else:
                try:
                    source_bytes, _media_type = content.read_bytes(
                        project or "", path, max_bytes=WORKBENCH_PREVIEW_MAX_BYTES
                    )
                except ContentError as exc:
                    raise _fail(exc) from exc
                content_kind = content_kind_for(source_bytes)
                viewer = viewer_for(path, source_bytes)
                capabilities = capabilities_for(path, source_bytes)
            admission: ResourceAdmissionPolicy | None = getattr(
                request.app.state, "resource_version_supervisor", None
            )
            versioning = admission.capability(snapshot.project_id, path) if admission else None
            capabilities = replace(
                capabilities,
                can_version=bool(versioning and versioning.can_version),
                can_edit=capabilities.can_edit and snapshot.writable,
                can_save=capabilities.can_save and snapshot.writable,
            )
        try:
            binding = content.identify(project or "", path) if viewer.value == "pdf" else None
        except ContentError as exc:
            raise _fail(exc) from exc
        return {
            "path": path,
            "viewer": viewer.value,
            "processor": (
                processor.kind.value if (processor := processor_for(path)) is not None else None
            ),
            "content_kind": content_kind.value,
            "capabilities": asdict(capabilities),
            "project_id": binding.asset.project_id if binding is not None else snapshot.project_id,
            "media_type": snapshot.media_type,
            "size": snapshot.size,
            "revision": snapshot.revision,
            "content_url": CONTENT_ROUTE,
            "asset_id": binding.asset.asset_id if binding is not None else None,
            "source_state": binding.state.value if binding is not None else None,
            "versioning": asdict(versioning) if versioning is not None else None,
        }

    @app.api_route(CONTENT_ROUTE, methods=["GET", "HEAD"])
    async def workbench_content(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
        preview: bool = Query(default=False),
    ) -> Response:
        content = _content(request)
        try:
            snapshot = content.snapshot(project or "", path)
        except ContentError as exc:
            raise _fail(exc) from exc
        headers = {
            "Accept-Ranges": "bytes",
            "ETag": _etag(snapshot.revision),
        }
        if request.method == "HEAD":
            headers["Content-Length"] = str(snapshot.size)
            return Response(media_type=snapshot.media_type, headers=headers)
        range_header = request.headers.get("range")
        if range_header:
            selected = parse_byte_range(range_header, snapshot.size)
            if selected is None:
                return Response(
                    status_code=RANGE_NOT_SATISFIABLE_STATUS,
                    headers={**headers, "Content-Range": f"bytes */{snapshot.size}"},
                )
            start, end = selected
            try:
                payload = content.read_range(project or "", path, start, end)
            except ContentError as exc:
                raise _fail(exc) from exc
            headers.update(
                {
                    "Content-Range": f"bytes {start}-{end}/{snapshot.size}",
                    "Content-Length": str(len(payload)),
                }
            )
            return Response(
                content=payload,
                status_code=PARTIAL_CONTENT_STATUS,
                media_type=snapshot.media_type,
                headers=headers,
            )
        try:
            payload, media_type = content.read_bytes(
                project or "", path, max_bytes=WORKBENCH_PREVIEW_MAX_BYTES
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        if preview:
            try:
                payload = WorkbenchFormatPolicy().preview(path, payload)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="invalid_spreadsheet") from exc
        headers["Content-Length"] = str(len(payload))
        return Response(content=payload, media_type=media_type, headers=headers)

    def project_pdf_document(
        content: ContentService, project: str, path: str, revision: str
    ) -> CitationDocument:
        snapshot = content.snapshot(project, path)
        if snapshot.revision != revision:
            raise HTTPException(status_code=CONFLICT_STATUS, detail="source_revision_conflict")
        payload, media_type = content.read_bytes(
            project, path, max_bytes=WORKBENCH_PREVIEW_MAX_BYTES
        )
        if media_type != "application/pdf":
            raise HTTPException(status_code=415, detail="pdf_source_invalid")
        return CitationDocument(snapshot.project_id, path, path, revision, payload)

    @app.get(PDF_REGIONS_ROUTE)
    def pdf_regions(
        request: Request,
        path: str = Query(...),
        project: str = Query(...),
        revision: str = Query(...),
        start_page: int = Query(..., ge=1),
        end_page: int = Query(..., ge=1),
    ) -> dict:
        try:
            document = project_pdf_document(_content(request), project, path, revision)
            return region_manifest(_pdf_indexes(request), document, start_page, end_page)
        except ContentError as exc:
            raise _fail(exc) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get(f"{PDF_REGIONS_ROUTE}/{{region_id}}/image")
    def pdf_region_image(
        region_id: str,
        request: Request,
        path: str = Query(...),
        project: str = Query(...),
        revision: str = Query(...),
        page: int = Query(..., ge=1),
        quad: list[float] | None = Query(default=None),
    ) -> Response:
        try:
            document = project_pdf_document(_content(request), project, path, revision)
            selected = resolve_region(_pdf_indexes(request), document, page, region_id, quad)
            return Response(crop_region(document.payload, selected), media_type="image/png")
        except ContentError as exc:
            raise _fail(exc) from exc
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.put(CONTENT_ROUTE)
    async def workbench_commit(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
    ) -> Response:
        if request.headers.get("content-type", "").split(";", 1)[0] != OCTET_STREAM_MEDIA_TYPE:
            raise HTTPException(status_code=415, detail="binary_content_type_required")
        expected = _expected_revision(request.headers.get("if-match"))
        payload = await request.body()
        project_id = project or ""
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            basis = "\0".join((project_id, path, expected, sha256(payload).hexdigest())).encode(
                UTF8_ENCODING
            )
            idempotency_key = "sha256:" + sha256(basis).hexdigest()
        try:
            receipt = _versions(request).commit_working(
                project_id,
                path,
                payload,
                expected,
                idempotency_key,
                automatic_version=True,
            )
        except (ContentError, ResourceVersionError) as exc:
            raise _fail(exc) from exc
        return Response(
            status_code=NO_CONTENT_STATUS,
            headers={"ETag": _etag(receipt.revision)},
        )

    @app.post(MANAGED_COPY_ROUTE)
    async def workbench_managed_copy(  # type: ignore[unused-ignore]
        request: Request,
        name: str = Query(...),
        project: str | None = Query(default=None),
    ) -> dict:
        """Preserve Workbench memory as a new managed resource with one complete v1."""

        if request.headers.get("content-type", "").split(";", 1)[0] != OCTET_STREAM_MEDIA_TYPE:
            raise HTTPException(status_code=415, detail="binary_content_type_required")
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="idempotency_key_required")
        try:
            receipt = _managed_copies(request).create_managed_copy(
                project or "", name, await request.body(), idempotency_key
            )
        except ContentError as exc:
            if exc.code in {
                "idempotency_conflict",
                "path_exists",
                "version_management_disabled",
            }:
                raise HTTPException(status_code=CONFLICT_STATUS, detail=exc.code) from exc
            raise _fail(exc) from exc
        return {
            "project": receipt.project_id,
            "path": receipt.path,
            "revision": receipt.revision,
        }

    @app.get(f"{WORKBENCH_ROUTE_PREFIX}/pdf")
    async def workbench_pdf(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
    ) -> Response:
        """PDF 字节通道 (架构文档 §3.4「PDF Range/ETag 读取通道」)。

        交给 Electron 内置的 Chromium PDF 插件渲染, 不自带 pdf.js:
        翻页、缩放、适应页面、缩略图、全文搜索、文本复制这些 PRD 列出的
        基础阅读能力它已全部具备且经过验证, 自建一套反而更差。
        划词高亮与批注面板需要文本层控制权, 本期不实现 (已与需求方对齐)。
        """

        try:
            payload, media = _content(request).read_bytes(
                project or "", path, max_bytes=WORKBENCH_PREVIEW_MAX_BYTES
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        return Response(
            content=payload,
            media_type=media,
            headers={
                # inline 让 Chromium 直接内嵌渲染而不是弹下载。
                "Content-Disposition": "inline",
                # 让 Viewer 能发 Range 请求跳页, 不必整份下载。
                "Accept-Ranges": "bytes",
            },
        )

    @app.post(f"{WORKBENCH_ROUTE_PREFIX}/images")
    async def workbench_image(
        request: Request,
        path: str = Query(...),
        project: str | None = Query(default=None),
    ) -> dict:
        payload = await request.body()
        media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        try:
            relative = persist_image(_content(request), project or "", path, payload, media_type)
        except ContentError as exc:
            raise _fail(exc) from exc
        return {"path": relative}

    @app.post(OFFICE_IMAGES_ROUTE)
    async def workbench_office_image(
        request: Request, path: str = Query(...), project: str | None = Query(default=None)
    ) -> dict:
        payload = bytearray()
        async for chunk in request.stream():
            if len(payload) + len(chunk) > OFFICE_IMAGE_MAX_BYTES:
                raise _fail(ContentError("file_too_large"))
            payload.extend(chunk)
        media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        try:
            return stage_office_image(
                _content(request), project or "", path, bytes(payload), media_type
            )
        except ContentError as exc:
            raise _fail(exc) from exc

    @app.delete(OFFICE_IMAGES_ROUTE, status_code=NO_CONTENT_STATUS)
    async def workbench_release_office_image(
        request: Request,
        path: str = Query(...),
        lease: str = Query(...),
        project: str | None = Query(default=None),
    ) -> Response:
        revision = _expected_revision(request.headers.get("if-match"))
        try:
            release_office_image(_content(request), project or "", path, lease, revision)
        except ContentError as exc:
            raise _fail(exc) from exc
        return Response(status_code=NO_CONTENT_STATUS)

    @app.get(ANNOTATIONS_ROUTE)
    async def workbench_pdf_annotations(  # type: ignore[unused-ignore]
        request: Request,
        asset_id: str,
        project: str | None = Query(default=None),
    ) -> dict:
        """Read stable asset-owned records without mutating the original PDF."""

        try:
            snapshot = _records(request).snapshot_asset(project or "", asset_id)
        except ContentError as exc:
            raise _fail(exc) from exc
        return snapshot.response()

    @app.put(ANNOTATIONS_ROUTE)
    async def workbench_pdf_annotations_commit(  # type: ignore[unused-ignore]
        request: Request,
        asset_id: str,
        project: str | None = Query(default=None),
    ) -> dict:
        """CAS-save validated JSON records independently of the original PDF."""

        expected = _expected_revision(request.headers.get("if-match"))
        try:
            body = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="invalid_annotations") from exc
        if (
            not isinstance(body, dict)
            or not isinstance(body.get("records"), dict)
            or not isinstance(body.get("expected_source_revision"), str)
        ):
            raise HTTPException(status_code=422, detail="invalid_annotations")
        try:
            snapshot = _records(request).commit_asset(
                project or "",
                asset_id,
                body["records"],
                expected,
                body["expected_source_revision"],
            )
        except ContentError as exc:
            raise _fail(exc) from exc
        return snapshot.response()


__all__ = ["WORKBENCH_ROUTE_PREFIX", "register_workbench_routes"]
