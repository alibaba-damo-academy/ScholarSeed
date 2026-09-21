"""Literature's exact attachment PDF resolver."""

from __future__ import annotations

from service.content.domain.model import ContentError
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    LiteratureAttachment,
    LiteratureItem,
    LiteratureView,
)
from service.platform.pdf import PdfDocumentError, PdfPasswordError, pdf_document_info

from .attachment import LiteratureAttachmentContent

PDF_MISSING = "literature_pdf_missing"


class LiteraturePdf:
    def __init__(self, repository: LiteratureRepository | None = None) -> None:
        self._repository = repository or LiteratureRepository()
        self._attachments = LiteratureAttachmentContent(self._repository)

    @staticmethod
    def _pdf(attachment: LiteratureAttachment | None) -> LiteratureAttachment:
        if attachment is None:
            raise ContentError(PDF_MISSING)
        if attachment.media_type != PDF_MEDIA_TYPE:
            raise ContentError("literature_attachment_not_pdf")
        return attachment

    def attachment(self, literature_id: str, attachment_id: str) -> LiteratureAttachment:
        return self._pdf(self._repository.attachment(literature_id, attachment_id))

    def primary(self, literature_id: str) -> LiteratureAttachment:
        return self._pdf(self._repository.primary_attachment(literature_id))

    def location_attachment(self, attachment: LiteratureAttachment) -> str:
        return self._attachments.location_attachment(self._pdf(attachment))

    def read_attachment(
        self,
        literature_id: str,
        attachment_id: str,
    ) -> tuple[bytes, str, str]:
        self.attachment(literature_id, attachment_id)
        payload, media_type, revision = self._attachments.read_attachment(
            literature_id, attachment_id
        )
        if media_type != PDF_MEDIA_TYPE:
            raise ContentError("literature_attachment_not_pdf")
        return payload, media_type, revision

    def location(self, item: LiteratureItem) -> str:
        return self.location_attachment(self.primary(item.id))

    def read(self, item: LiteratureItem) -> tuple[bytes, str]:
        attachment = self.primary(item.id)
        payload, media_type, _revision = self.read_attachment(item.id, attachment.id)
        return payload, media_type

    def page_count(self, item: LiteratureItem) -> int:
        """Read the managed PDF through the shared structure boundary."""

        payload, _media_type = self.read(item)
        try:
            return pdf_document_info(payload).page_count
        except PdfPasswordError as error:
            raise ContentError("pdf_password_required") from error
        except PdfDocumentError as error:
            raise ContentError("pdf_parse_failed") from error

    def project(self, project_id: str, view: LiteratureView) -> LiteratureView:
        del project_id
        return view


__all__ = ["LiteraturePdf", "PDF_MISSING"]
