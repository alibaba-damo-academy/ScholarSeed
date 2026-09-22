"""Exact literature-attachment open, content, and PDF record routes."""

from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request, Response

from service.content.domain.model import ContentError
from service.literature.api.importer import register_attachment_import
from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.persistence.reading import (
    AttachmentOwnerMismatch,
    AttachmentRecordCatalog,
    AttachmentRecordConflict,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.pdf import LiteraturePdf
from service.platform.citations import (
    LITERATURE_STORAGE,
    PDF_INDEX_STATE,
    CitationDocument,
    PdfIndexPort,
)
from service.platform.pdf import PdfAnnotationError, embedded_pdf_records
from service.platform.ranges import parse_byte_range
from service.platform.records import EMPTY_RECORDS, ProjectPdfRecordPort, RecordOwner, RecordTarget
from service.platform.resources import ResourceManagedCopyPort
from service.platform.workbench import DocumentFormatPort
from service.workbench.service.regions import crop as crop_region
from service.workbench.service.regions import manifest as region_manifest
from service.workbench.service.regions import region as resolve_region

MAX_RECORD_BYTES = 10 * 1024 * 1024
OCTET_STREAM_MEDIA_TYPE = "application/octet-stream"
NO_CONTENT_STATUS = 204
PRECONDITION_REQUIRED_STATUS = 428
ROUTE = "/api/v1/literatures/{literature_id}/attachments/{attachment_id}"
IDEMPOTENCY_HEADER = "idempotency-key"
PARTIAL_CONTENT_STATUS = 206
RANGE_NOT_SATISFIABLE_STATUS = 416
CONTENT_ERROR_STATUS = {
    "literature_attachment_missing": 404,
    "literature_attachment_invalid": 422,
    "literature_attachment_type_mismatch": 422,
    "literature_attachment_unreadable": 422,
    "literature_attachment_read_only": 415,
    "revision_conflict": 412,
    "literature_pdf_missing": 404,
    "literature_attachment_not_pdf": 415,
    "unknown_project": 404,
    "file_not_found": 404,
    "prepared_content_unavailable": 404,
}
CONTENT_ERROR_MESSAGE = {
    "literature_attachment_missing": "附件不存在或已被移除",
    "literature_attachment_invalid": "附件内容损坏，无法预览",
    "literature_attachment_type_mismatch": "附件内容与文件类型不匹配",
    "literature_attachment_unreadable": "附件当前无法读取",
    "literature_attachment_read_only": "该附件格式不支持编辑",
    "revision_conflict": "附件已被其他窗口修改，请重新打开后再编辑",
    "literature_pdf_missing": "PDF 附件不存在或已被移除",
    "literature_attachment_not_pdf": "该附件不是 PDF，不能使用批注功能",
    "unknown_project": "附件所属项目不存在",
    "file_not_found": "附件文件不存在",
    "prepared_content_unavailable": "附件内容尚不可用",
}
RETRYABLE_CONTENT_ERRORS = frozenset(
    {
        "literature_attachment_unreadable",
        "prepared_content_unavailable",
    }
)


def _target(literature_id: str, attachment_id: str) -> RecordTarget:
    return RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, literature_id, attachment_id)


def _content_error(error: ContentError) -> HTTPException:
    return HTTPException(
        CONTENT_ERROR_STATUS.get(error.code, 400),
        {
            "code": error.code,
            "message": CONTENT_ERROR_MESSAGE.get(error.code, "附件打开失败"),
            "retryable": error.code in RETRYABLE_CONTENT_ERRORS,
        },
    )


def _managed_copies(request: Request) -> ResourceManagedCopyPort:
    service = getattr(request.app.state, "resource_version_supervisor", None)
    if service is None:
        raise HTTPException(503, "resource_versions_unavailable")
    return service


def _project_records(request: Request) -> ProjectPdfRecordPort:
    service = getattr(request.app.state, "pdf_records", None)
    if service is None:
        raise HTTPException(503, "records_unavailable")
    return service


def _pdf_indexes(request: Request) -> PdfIndexPort:
    service = getattr(request.app.state, PDF_INDEX_STATE, None)
    if service is None:
        raise HTTPException(503, "pdf_index_unavailable")
    return service


def register_reading_routes(
    app: FastAPI,
    repository: LiteratureRepository,
    attachments: LiteratureAttachmentContent,
    pdf: LiteraturePdf,
    formats: DocumentFormatPort,
) -> None:
    catalog = AttachmentRecordCatalog(repository.database)
    register_attachment_import(app, attachments, catalog)

    @app.get(f"{ROUTE}/open")
    def open_attachment(literature_id: str, attachment_id: str) -> Response:
        try:
            attachment = attachments.attachment(literature_id, attachment_id)
            data, media_type, revision = attachments.read_attachment(literature_id, attachment_id)
        except ContentError as error:
            raise _content_error(error) from error
        projection = formats.project(attachment.name, data)
        return Response(
            content=json.dumps(
                {
                    "viewer": projection.viewer,
                    "processor": projection.processor,
                    "content_kind": projection.content_kind,
                    "capabilities": {
                        "can_preview": projection.can_preview,
                        "can_edit": projection.can_edit,
                        "can_select": projection.can_select,
                        "can_annotate": projection.can_annotate,
                        "can_save": projection.can_save,
                        "can_version": False,
                        "can_diff": False,
                        "pending": list(projection.pending),
                    },
                    "media_type": media_type,
                    "size": len(data),
                    "revision": revision,
                }
            ),
            media_type="application/json",
            headers={"ETag": f'"{revision}"'},
        )

    @app.get(f"{ROUTE}/location")
    def location(literature_id: str, attachment_id: str) -> dict[str, str]:
        try:
            absolute = attachments.absolute_location(literature_id, attachment_id)
        except ContentError as error:
            raise _content_error(error) from error
        return {"absolute": absolute}

    @app.api_route(f"{ROUTE}/content", methods=["GET", "HEAD"])
    def content(
        literature_id: str,
        attachment_id: str,
        request: Request,
        preview: bool = Query(default=False),
    ) -> Response:
        try:
            attachment = attachments.attachment(literature_id, attachment_id)
            data, media_type, revision = attachments.read_attachment(literature_id, attachment_id)
        except ContentError as error:
            raise _content_error(error) from error
        if preview:
            try:
                data = formats.preview(attachment.name, data)
            except ValueError as error:
                raise _content_error(ContentError("literature_attachment_invalid")) from error
        size = len(data)
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(attachment.name, safe='')}",
            "ETag": f'"{revision}"',
            "X-Content-Type-Options": "nosniff",
        }
        if request.method == "HEAD":
            headers["Content-Length"] = str(size)
            return Response(media_type=media_type, headers=headers)
        range_header = request.headers.get("range")
        if range_header:
            selected = parse_byte_range(range_header, size)
            if selected is None:
                return Response(
                    status_code=RANGE_NOT_SATISFIABLE_STATUS,
                    headers={**headers, "Content-Range": f"bytes */{size}"},
                )
            start, end = selected
            payload = data[start : end + 1]
            headers.update(
                {
                    "Content-Length": str(len(payload)),
                    "Content-Range": f"bytes {start}-{end}/{size}",
                }
            )
            return Response(
                payload,
                status_code=PARTIAL_CONTENT_STATUS,
                media_type=media_type,
                headers=headers,
            )
        headers["Content-Length"] = str(size)
        return Response(data, media_type=media_type, headers=headers)

    def attachment_document(literature_id: str, attachment_id: str) -> CitationDocument:
        attachment = attachments.attachment(literature_id, attachment_id)
        data, media_type, revision = attachments.read_attachment(literature_id, attachment_id)
        if media_type != "application/pdf":
            raise ContentError("literature_attachment_not_pdf")
        return CitationDocument(
            "",
            f"{literature_id}/{attachment_id}",
            attachment.name,
            revision,
            data,
            storage_scope=LITERATURE_STORAGE,
        )

    @app.get(f"{ROUTE}/regions")
    def visual_regions(
        literature_id: str,
        attachment_id: str,
        request: Request,
        revision: str = Query(...),
        start_page: int = Query(..., ge=1),
        end_page: int = Query(..., ge=1),
    ) -> dict:
        try:
            document = attachment_document(literature_id, attachment_id)
            if document.revision != revision:
                raise HTTPException(409, "source_revision_conflict")
            return region_manifest(_pdf_indexes(request), document, start_page, end_page)
        except ContentError as error:
            raise _content_error(error) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.get(f"{ROUTE}/regions/{{region_id}}/image")
    def visual_region_image(
        literature_id: str,
        attachment_id: str,
        region_id: str,
        request: Request,
        revision: str = Query(...),
        page: int = Query(..., ge=1),
    ) -> Response:
        try:
            document = attachment_document(literature_id, attachment_id)
            if document.revision != revision:
                raise HTTPException(409, "source_revision_conflict")
            selected = resolve_region(_pdf_indexes(request), document, page, region_id)
            return Response(crop_region(document.payload, selected), media_type="image/png")
        except ContentError as error:
            raise _content_error(error) from error
        except ValueError as error:
            raise HTTPException(404, str(error)) from error

    @app.put(f"{ROUTE}/content")
    async def commit_content(
        literature_id: str,
        attachment_id: str,
        request: Request,
    ) -> Response:
        if request.headers.get("content-type", "").split(";", 1)[0] != OCTET_STREAM_MEDIA_TYPE:
            raise HTTPException(415, "binary_content_type_required")
        expected = request.headers.get("if-match", "").strip()
        if expected.startswith("W/"):
            raise HTTPException(412, "revision_conflict")
        expected = expected.strip('"')
        if not expected:
            raise HTTPException(PRECONDITION_REQUIRED_STATUS, "revision_required")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_IMPORT_BYTES:
                raise HTTPException(413, "attachment_too_large")
        try:
            attachment = attachments.attachment(literature_id, attachment_id)
            current, _media_type, _revision = attachments.read_attachment(
                literature_id, attachment_id
            )
            current_projection = formats.project(attachment.name, current)
            replacement_projection = formats.project(attachment.name, bytes(body))
            if not current_projection.can_save:
                raise ContentError("literature_attachment_read_only")
            if (
                not replacement_projection.can_save
                or replacement_projection.viewer != current_projection.viewer
            ):
                raise ContentError("literature_attachment_invalid")
            # 换内容 = 换一份独占文件: 旧文件与它派生的全文索引都在这一步里收掉,
            # 否则旧 revision 的索引行会永远留在库里, 再也没人能指认它。
            revision = attachments.commit_attachment(
                literature_id,
                attachment_id,
                bytes(body),
                expected,
                getattr(request.app.state, PDF_INDEX_STATE, None),
            )
        except ContentError as error:
            raise _content_error(error) from error
        return Response(
            status_code=NO_CONTENT_STATUS,
            headers={"ETag": f'"{revision}"'},
        )

    @app.get(f"{ROUTE}/records")
    def records(
        literature_id: str,
        attachment_id: str,
    ) -> dict:
        try:
            data, _media_type, source_revision = pdf.read_attachment(literature_id, attachment_id)
            initial = None if catalog.exists(attachment_id) else embedded_pdf_records(data)
            return catalog.snapshot(
                _target(literature_id, attachment_id), source_revision, initial
            ).response()
        except PdfAnnotationError as error:
            raise HTTPException(422, "invalid_annotations") from error
        except AttachmentOwnerMismatch as error:
            raise HTTPException(404, "literature_attachment_not_found") from error
        except ContentError as error:
            raise _content_error(error) from error

    @app.put(f"{ROUTE}/records")
    async def save(
        literature_id: str,
        attachment_id: str,
        request: Request,
    ) -> dict:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_RECORD_BYTES:
                raise HTTPException(413, "records_too_large")
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, ValueError) as error:
            raise HTTPException(422, "invalid_annotations") from error
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("records"), dict)
            or not isinstance(payload.get("expected_source_revision"), str)
        ):
            raise HTTPException(422, "invalid_annotations")
        expected = request.headers.get("if-match", "").strip('"')
        if not expected:
            raise HTTPException(428, "revision_required")
        try:
            _data, _media_type, source_revision = pdf.read_attachment(literature_id, attachment_id)
            if source_revision != payload["expected_source_revision"]:
                raise HTTPException(409, "source_revision_conflict")
            return catalog.commit(
                _target(literature_id, attachment_id),
                source_revision,
                payload["records"],
                expected,
            ).response()
        except AttachmentOwnerMismatch as error:
            raise HTTPException(404, "literature_attachment_not_found") from error
        except AttachmentRecordConflict as error:
            raise HTTPException(412, "revision_conflict") from error
        except ContentError as error:
            raise _content_error(error) from error
        except (TypeError, ValueError) as error:
            raise HTTPException(422, "invalid_annotations") from error

    @app.post(f"{ROUTE}/copy-to-project")
    def copy_to_project(
        literature_id: str,
        attachment_id: str,
        request: Request,
        name: str = Query(...),
        project: str = Query(...),
        copy_records: bool = Query(default=False),
    ) -> dict:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER, "").strip()
        if not idempotency_key:
            raise HTTPException(400, "idempotency_key_required")
        try:
            payload, _media_type, source_revision = pdf.read_attachment(
                literature_id, attachment_id
            )
            receipt = _managed_copies(request).create_managed_copy(
                project, name, payload, idempotency_key
            )
            binding = request.app.state.content.identify(project, receipt.path)
            asset_id = binding.asset.asset_id
            if asset_id is None:
                raise ContentError("records_uninitialized")
            target_snapshot = _project_records(request).snapshot_asset(
                project, asset_id, initial_records=EMPTY_RECORDS
            )
            copied_revision = ""
            if copy_records:
                initial = None if catalog.exists(attachment_id) else embedded_pdf_records(payload)
                source_snapshot = catalog.snapshot(
                    _target(literature_id, attachment_id), source_revision, initial
                )
                if target_snapshot.records != source_snapshot.records:
                    if target_snapshot.records != EMPTY_RECORDS:
                        raise HTTPException(409, "copy_target_records_conflict")
                    target_snapshot = _project_records(request).commit_asset(
                        project,
                        asset_id,
                        source_snapshot.records,
                        target_snapshot.record_revision,
                        target_snapshot.source_revision,
                    )
                copied_revision = target_snapshot.record_revision
            return {
                "source_target": _target(literature_id, attachment_id).response(),
                "target_target": target_snapshot.record_target.response(),
                "project": receipt.project_id,
                "path": receipt.path,
                "source_revision": source_revision,
                "record_revision": copied_revision or None,
                "records_copied": copy_records,
            }
        except PdfAnnotationError as error:
            raise HTTPException(422, "invalid_annotations") from error
        except ContentError as error:
            raise _content_error(error) from error


__all__ = ["register_reading_routes"]
