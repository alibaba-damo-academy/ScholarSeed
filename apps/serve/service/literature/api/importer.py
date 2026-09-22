"""Owner-resolved attachment import composed with resource and content ports."""

from __future__ import annotations

import json
from pathlib import PurePosixPath

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from service.content.domain.model import ContentError
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.schema import PDF_MEDIA_TYPE
from service.literature.service.attachment import LiteratureAttachmentContent
from service.platform.content import RootKind
from service.platform.pdf import PdfAnnotationError, embedded_pdf_records
from service.platform.records import (
    EMPTY_RECORDS,
    ProjectPdfRecordPort,
    RecordOwner,
    RecordTarget,
    record_revision,
)
from service.platform.resources import ResourcePayloadImportPort

IMPORT_ROUTE = "/api/v1/literatures/{literature_id}/attachments/{attachment_id}/import-to-project"
IDEMPOTENCY_HEADER = "idempotency-key"
IMPORT_ERROR_STATUS = 409
UNAVAILABLE_STATUS = 503
ATTACHMENT_RECORDS_UNSUPPORTED = "attachment_records_unsupported"


class AttachmentImportRequest(BaseModel):
    project: str = Field(min_length=1)
    parent: str = ""
    name: str = Field(min_length=1)
    replace_path: str | None = None
    copy_records: bool = False
    replace_records: bool = False
    preview: bool = True
    token: str | None = None
    source_record_revision: str | None = None
    target_record_revision: str | None = None

    @model_validator(mode="after")
    def validate_options(self) -> "AttachmentImportRequest":
        if self.replace_path and self.copy_records and not self.replace_records:
            raise ValueError("record_replacement_confirmation_required")
        if not self.preview and not self.token:
            raise ValueError("import_plan_required")
        return self


def register_attachment_import(
    app: FastAPI,
    attachments: LiteratureAttachmentContent,
    catalog: AttachmentRecordCatalog,
) -> None:
    @app.post(IMPORT_ROUTE)
    # 链接模式移除后这条路由全程同步 (读附件字节、写项目资源、写记录台账),
    # 交给 FastAPI 的线程池跑, 不要占着事件循环做阻塞 IO。
    def import_to_project(
        literature_id: str, attachment_id: str, body: AttachmentImportRequest, request: Request
    ) -> dict:
        resources: ResourcePayloadImportPort | None = getattr(app.state, "resource_importer", None)
        if resources is None:
            raise HTTPException(UNAVAILABLE_STATUS, "resource_import_unavailable")
        key = request.headers.get(IDEMPOTENCY_HEADER, "").strip()
        if not body.preview and not key:
            raise HTTPException(400, "idempotency_key_required")
        receipt = None
        try:
            content = app.state.content
            attachment = attachments.attachment(literature_id, attachment_id)
            payload, media_type, revision = attachments.read_attachment(
                literature_id, attachment_id
            )
            source_suffix = PurePosixPath(attachment.name).suffix.casefold()
            if PurePosixPath(body.name).suffix.casefold() != source_suffix:
                raise ContentError("invalid_name")
            supports_records = media_type == PDF_MEDIA_TYPE
            if not supports_records and (body.copy_records or body.replace_records):
                raise ContentError(ATTACHMENT_RECORDS_UNSUPPORTED)
            records: ProjectPdfRecordPort | None = getattr(app.state, "pdf_records", None)
            if supports_records and records is None:
                raise HTTPException(UNAVAILABLE_STATUS, "resource_import_unavailable")
            parent = content.within_root(body.project, RootKind.RESOURCES, body.parent)
            source_target = RecordTarget(
                RecordOwner.LITERATURE_ATTACHMENT, literature_id, attachment_id
            )
            source_records = (
                catalog.snapshot(
                    source_target,
                    revision,
                    None if catalog.exists(attachment_id) else embedded_pdf_records(payload),
                )
                if body.copy_records
                else None
            )
            if (
                source_records is not None
                and not body.preview
                and (source_records.record_revision != body.source_record_revision)
            ):
                raise ContentError("source_record_revision_conflict")
            target = None
            if body.replace_path:
                if PurePosixPath(body.replace_path).suffix.casefold() != source_suffix:
                    raise ContentError("replace_not_supported")
                binding = content.identify(body.project, body.replace_path)
                target = (
                    records.snapshot_asset(body.project, binding.asset.asset_id)
                    if supports_records and records is not None
                    else None
                )
                if (
                    target is not None
                    and not body.preview
                    and target.record_revision != body.target_record_revision
                    and (source_records is None or target.records != source_records.records)
                ):
                    raise ContentError("target_record_revision_conflict")
            target_record_revision = (
                target.record_revision if body.preview and target else body.target_record_revision
            )
            context = json.dumps(
                {
                    "source": source_target.response(),
                    "copy_records": body.copy_records,
                    "replace_records": body.replace_records,
                    "source_records": source_records.record_revision if source_records else None,
                    "target_records": target_record_revision,
                },
                sort_keys=True,
            )
            preview = (
                resources.preview_payload(
                    body.project,
                    parent,
                    body.name,
                    payload,
                    replace_path=body.replace_path,
                    context=context,
                )
                if body.preview
                else None
            )
            if preview is not None:
                return {
                    "status": "preview",
                    **preview.response(),
                    "source_record_revision": (
                        source_records.record_revision if source_records else None
                    ),
                    "target_record_revision": target_record_revision,
                }
            if body.token is None:
                raise ContentError("import_plan_required")
            receipt = resources.import_payload(
                body.project,
                parent,
                body.name,
                payload,
                body.token,
                key,
                replace_path=body.replace_path,
                context=context,
            )
            if not supports_records:
                resources.finish_payload(body.project, receipt.path, receipt.revision)
                return {
                    "status": "completed",
                    "path": receipt.path,
                    "project": body.project,
                    "records_copied": False,
                    "source_target": source_target.response(),
                }
            if records is None:
                raise ContentError(ATTACHMENT_RECORDS_UNSUPPORTED)
            binding = content.identify(body.project, receipt.path)
            current = records.snapshot_asset(
                body.project, binding.asset.asset_id, initial_records=EMPTY_RECORDS
            )
            desired = source_records.records if source_records is not None else EMPTY_RECORDS
            if current.records != desired and (source_records is not None or not body.replace_path):
                # Resource version capture may already have initialized this new
                # asset from the embedded records. CAS only accepts that original
                # initialization or an empty initialization, never unrelated edits.
                initial = (
                    EMPTY_RECORDS
                    if current.records == EMPTY_RECORDS
                    else embedded_pdf_records(payload)
                )
                expected = (
                    body.target_record_revision
                    if body.replace_path
                    else record_revision(receipt.revision, initial)
                )
                if expected is None:
                    raise ContentError("target_record_revision_required")
                current = records.commit_asset(
                    body.project,
                    binding.asset.asset_id,
                    desired,
                    expected,
                    receipt.revision,
                )
            resources.finish_payload(body.project, receipt.path, receipt.revision)
            return {
                "status": "completed",
                "path": receipt.path,
                "project": body.project,
                "records_copied": body.copy_records,
                "source_target": source_target.response(),
                "target_target": current.record_target.response(),
            }
        except PdfAnnotationError as error:
            raise HTTPException(422, "invalid_annotations") from error
        except ContentError as error:
            raise HTTPException(
                IMPORT_ERROR_STATUS,
                {
                    "code": error.code,
                    "message": error.code,
                    "fields": {"path": receipt.path} if receipt is not None else {},
                },
            ) from error
        except RuntimeError as error:
            code = getattr(error, "code", None)
            if code is None:
                raise
            raise HTTPException(
                IMPORT_ERROR_STATUS,
                {
                    "code": code,
                    "message": code,
                    "fields": {"path": receipt.path} if receipt is not None else {},
                },
            ) from error
