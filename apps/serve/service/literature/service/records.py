"""Canonical literature-owned PDF records exposed through the shared record port."""

from __future__ import annotations

from typing import Any

from service.content.domain.model import ContentError
from service.literature.persistence.reading import (
    AttachmentOwnerMismatch,
    AttachmentRecordCatalog,
    AttachmentRecordConflict,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.attachment import LiteratureAttachmentContent
from service.platform.pdf import PdfAnnotationError, embedded_pdf_records
from service.platform.records import (
    NATIVE_ANNOTATIONS,
    RECORD_SOURCE_UNAVAILABLE,
    PdfRecordSnapshot,
    RecordTarget,
    record_revision,
)


def attachment_snapshot(
    catalog: AttachmentRecordCatalog, target: RecordTarget, revision: str, payload: bytes
) -> PdfRecordSnapshot:
    """Backfill native records once, using a revision guard against concurrent edits."""
    existing = catalog.peek(target, revision)
    if existing is None:
        return catalog.snapshot(target, revision, embedded_pdf_records(payload))
    if (
        NATIVE_ANNOTATIONS in existing.records
        or record_revision(revision, existing.records) != existing.record_revision
    ):
        return existing
    enriched = embedded_pdf_records(payload, existing.records)
    if enriched == existing.records:
        return existing
    try:
        return catalog.commit(target, revision, enriched, existing.record_revision)
    except AttachmentRecordConflict:
        return catalog.peek(target, revision) or existing


class AttachmentRecords:
    def __init__(
        self, attachments: LiteratureAttachmentContent, repository: LiteratureRepository
    ) -> None:
        self._attachments = attachments
        self._catalog = AttachmentRecordCatalog(repository.database, changes=repository.changes)

    def snapshot_target(self, target: RecordTarget) -> PdfRecordSnapshot:
        try:
            payload, _media, revision = self._attachments.read_attachment(
                target.scope_id, target.subject_id
            )
            return attachment_snapshot(self._catalog, target, revision, payload)
        except PdfAnnotationError as error:
            raise ContentError("invalid_annotations") from error
        except AttachmentOwnerMismatch as error:
            raise ContentError(RECORD_SOURCE_UNAVAILABLE) from error
        except ContentError as error:
            raise ContentError(RECORD_SOURCE_UNAVAILABLE) from error

    def peek_target(self, target: RecordTarget) -> PdfRecordSnapshot:
        try:
            payload, _media, revision = self._attachments.read_attachment(
                target.scope_id, target.subject_id, read_only=True
            )
            existing = self._catalog.peek(target, revision)
            if existing is not None:
                return existing
            records = embedded_pdf_records(payload)
            return PdfRecordSnapshot(
                target, record_revision(revision, records), revision, "available", records
            )
        except AttachmentOwnerMismatch as error:
            raise ContentError("record_owner_mismatch") from error
        except (PdfAnnotationError, ValueError) as error:
            raise ContentError(RECORD_SOURCE_UNAVAILABLE) from error

    def commit_target(
        self,
        target: RecordTarget,
        records: dict[str, Any],
        expected_record_revision: str,
        expected_source_revision: str,
    ) -> PdfRecordSnapshot:
        snapshot = self.snapshot_target(target)
        if snapshot.source_revision != expected_source_revision:
            raise ContentError("source_revision_conflict")
        try:
            return self._catalog.commit(
                target, snapshot.source_revision, records, expected_record_revision
            )
        except AttachmentRecordConflict as error:
            raise ContentError("revision_conflict") from error
        except (TypeError, ValueError) as error:
            raise ContentError("invalid_annotations") from error
