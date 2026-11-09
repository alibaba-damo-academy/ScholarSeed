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
from service.platform.records import RECORD_SOURCE_UNAVAILABLE, PdfRecordSnapshot, RecordTarget


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
            initial = (
                None if self._catalog.exists(target.subject_id) else embedded_pdf_records(payload)
            )
            return self._catalog.snapshot(target, revision, initial)
        except PdfAnnotationError as error:
            raise ContentError("invalid_annotations") from error
        except AttachmentOwnerMismatch as error:
            raise ContentError(RECORD_SOURCE_UNAVAILABLE) from error
        except ContentError as error:
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
