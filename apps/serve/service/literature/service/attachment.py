"""Canonical format policy and exact content access for literature attachments."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path, PurePath

from service.content.domain.model import ContentError
from service.literature.persistence.files import (
    LiteratureFileBatch,
    delete_attachments,
    is_managed_attachment,
    managed_object,
    payload_revision,
    read_attachment,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import (
    BINARY_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    PNG_MEDIA_TYPE,
    LiteratureAttachment,
)
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.citations import PdfIndexForgetPort
from service.platform.files import guess_media_type
from service.platform.pdf import PdfDocumentError, pdf_document_info

ATTACHMENT_MISSING = "literature_attachment_missing"
ATTACHMENT_INVALID = "literature_attachment_invalid"
ATTACHMENT_TYPE_MISMATCH = "literature_attachment_type_mismatch"
ATTACHMENT_UNREADABLE = "literature_attachment_unreadable"
PATH_NOT_AUTHORIZED = "path_not_authorized"
REVISION_CONFLICT = "revision_conflict"
PDF_KIND = "pdf"
IMAGE_KIND = "image"
FILE_KIND = "file"
PDF_SIGNATURE = b"%PDF-"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_IHDR = b"IHDR"
PNG_IHDR_OFFSET = 12
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class AttachmentFormat:
    media_type: str
    kind: str
    suffixes: tuple[str, ...]
    signatures: tuple[bytes, ...]

    def matches(self, payload: bytes) -> bool:
        return any(payload.startswith(signature) for signature in self.signatures)

    def validates(self, payload: bytes) -> bool:
        if self.media_type == PDF_MEDIA_TYPE:
            try:
                return pdf_document_info(payload).page_count > 0
            except PdfDocumentError:
                return False
        if self.media_type == PNG_MEDIA_TYPE:
            return (
                payload.startswith(PNG_SIGNATURE)
                and payload[PNG_IHDR_OFFSET : PNG_IHDR_OFFSET + len(PNG_IHDR)] == PNG_IHDR
            )
        return True


ATTACHMENT_FORMATS = (
    AttachmentFormat(
        PDF_MEDIA_TYPE,
        PDF_KIND,
        (".pdf",),
        (PDF_SIGNATURE,),
    ),
    AttachmentFormat(
        PNG_MEDIA_TYPE,
        IMAGE_KIND,
        (".png",),
        (PNG_SIGNATURE,),
    ),
)
FORMAT_BY_SUFFIX = {
    suffix: registration for registration in ATTACHMENT_FORMATS for suffix in registration.suffixes
}
BINARY_FORMAT = AttachmentFormat(
    BINARY_MEDIA_TYPE,
    FILE_KIND,
    (),
    (),
)


class AttachmentFormatError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def detected_format(payload: bytes) -> AttachmentFormat:
    return next(
        (candidate for candidate in ATTACHMENT_FORMATS if candidate.matches(payload)),
        BINARY_FORMAT,
    )


def upload_format(name: str, payload: bytes, declared_media_type: str = "") -> AttachmentFormat:
    """Validate a supported filename/declaration against bytes and return canonical format."""

    detected = detected_format(payload)
    if detected is not BINARY_FORMAT and not detected.validates(payload):
        raise AttachmentFormatError(ATTACHMENT_INVALID)
    declared = FORMAT_BY_SUFFIX.get(PurePath(name).suffix.lower())
    if declared is not None and detected.media_type != declared.media_type:
        raise AttachmentFormatError(ATTACHMENT_TYPE_MISMATCH)
    declared_type = declared_media_type.split(";", 1)[0].strip().lower()
    registered_type = next(
        (candidate for candidate in ATTACHMENT_FORMATS if candidate.media_type == declared_type),
        None,
    )
    if registered_type is not None and detected.media_type != registered_type.media_type:
        raise AttachmentFormatError(ATTACHMENT_TYPE_MISMATCH)
    if detected is not BINARY_FORMAT:
        return detected
    return AttachmentFormat(
        media_type=guess_media_type(name) or BINARY_MEDIA_TYPE,
        kind=FILE_KIND,
        suffixes=(),
        signatures=(),
    )


class LiteratureAttachmentContent:
    """Read and replace the exact bytes one attachment row owns."""

    def __init__(self, repository: LiteratureRepository | None = None) -> None:
        self._repository = repository or LiteratureRepository()

    def attachment(self, literature_id: str, attachment_id: str) -> LiteratureAttachment:
        attachment = self._repository.attachment(literature_id, attachment_id)
        if attachment is None:
            raise ContentError(ATTACHMENT_MISSING)
        return attachment

    def location_attachment(self, attachment: LiteratureAttachment) -> str:
        """Return the file a row owns, refusing anything outside the literature store.

        附件行只可能指向托管目录里属于它自己的那一份副本: 指向项目文件 / 内容资产的
        link 语义已经删掉, 所以这里剩下的判断是"这行还完好吗", 不是"去哪里解析它"。
        """

        if not attachment.path or not is_managed_attachment(attachment.path):
            raise ContentError(ATTACHMENT_MISSING)
        read_attachment(attachment.path)
        return attachment.path

    def absolute_location(self, literature_id: str, attachment_id: str) -> str:
        location = self.location_attachment(self.attachment(literature_id, attachment_id))
        return str(Path(location).resolve())

    def read_absolute(self, location: str) -> tuple[bytes, str]:
        """Serve one owned file to Content's absolute-path citation reader.

        这条入口收的是"会话里按绝对路径引用的文件", 所以先确认这个路径确实登记在某条
        附件行上, 否则等于把托管目录之外的任意路径也放开了。
        """

        path = str(Path(location).expanduser().resolve())
        if not is_managed_attachment(path) or not self._repository.has_attachment_path(path):
            raise ContentError(PATH_NOT_AUTHORIZED)
        try:
            payload = read_attachment(path)
        except FileNotFoundError as error:
            raise ContentError(ATTACHMENT_MISSING) from error
        except (OSError, ValueError) as error:
            raise ContentError(ATTACHMENT_UNREADABLE) from error
        return payload, detected_format(payload).media_type

    def read_attachment(
        self,
        literature_id: str,
        attachment_id: str,
    ) -> tuple[bytes, str, str]:
        attachment = self.attachment(literature_id, attachment_id)
        if not attachment.path or not is_managed_attachment(attachment.path):
            raise ContentError(ATTACHMENT_MISSING)
        try:
            payload = read_attachment(attachment.path)
        except ContentError:
            raise
        except FileNotFoundError as error:
            raise ContentError(ATTACHMENT_MISSING) from error
        except (OSError, ValueError) as error:
            raise ContentError(ATTACHMENT_UNREADABLE) from error
        detected = detected_format(payload)
        media_type = (
            detected.media_type
            if detected is not BINARY_FORMAT
            else (
                attachment.media_type
                if attachment.media_type != BINARY_MEDIA_TYPE
                else guess_media_type(attachment.name) or BINARY_MEDIA_TYPE
            )
        )
        # 修订号永远从字节现算: 它要当 CAS 的 If-Match, 必须描述调用方此刻真读到的
        # 内容, 而不是行里那个可能来自上一次写入的值。
        return payload, media_type, payload_revision(payload)

    def commit_attachment(
        self,
        literature_id: str,
        attachment_id: str,
        payload: bytes,
        expected_revision: str,
        indexes: PdfIndexForgetPort | None = None,
    ) -> str:
        """CAS exact bytes onto a brand-new file this row alone owns."""

        attachment = self.attachment(literature_id, attachment_id)
        _current, _media_type, current_revision = self.read_attachment(literature_id, attachment_id)
        if current_revision != expected_revision:
            raise ContentError(REVISION_CONFLICT)
        try:
            replacement = upload_format(attachment.name, payload, attachment.media_type)
        except AttachmentFormatError as error:
            raise ContentError(error.code) from error
        suffix = PurePath(attachment.name).suffix.lower()
        published = managed_object(literature_id, payload, suffix)
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            location = batch.stage(published.name, payload)

            def publish() -> None:
                changed = self._repository.replace_attachment_location(
                    literature_id,
                    attachment_id,
                    attachment.path,
                    location,
                    published.revision,
                    replacement.media_type,
                    replacement.kind,
                )
                if not changed:
                    raise ContentError(REVISION_CONFLICT)

            batch.commit_operation(publish)
        # 旧文件只属于这一行 (名字里带 uuid, 新位置必然不同), 所以直接删, 不需要
        # 任何引用计数; 它派生的全文索引一起忘掉 —— 内容换过之后那些行再也不会被
        # 命中, 留着只是库里的垃圾。
        try:
            delete_attachments((attachment.path,))
        except OSError:
            LOGGER.warning("failed to remove superseded literature attachment")
        forget_removed_indexes(indexes, (attachment.revision or current_revision,))
        return published.revision


def forget_removed_indexes(indexes: PdfIndexForgetPort | None, revisions: tuple[str, ...]) -> int:
    """Drop cached full-text indexes whose source bytes are gone.

    键来自附件行存下的 revision: 删除那一刻文件已经 unlink, 既读不到字节, 文件名里
    也不再带可反推的摘要, 行里那一列是唯一还指得出"该忘哪一份"的地方。调用方交过来
    的必须是这次真的消失了的修订号。
    """
    if indexes is None:
        return 0
    unique = tuple(dict.fromkeys(revision for revision in revisions if revision))
    return indexes.forget_literature(unique) if unique else 0


__all__ = [
    "ATTACHMENT_FORMATS",
    "ATTACHMENT_INVALID",
    "ATTACHMENT_MISSING",
    "ATTACHMENT_TYPE_MISMATCH",
    "ATTACHMENT_UNREADABLE",
    "REVISION_CONFLICT",
    "AttachmentFormat",
    "AttachmentFormatError",
    "LiteratureAttachmentContent",
    "detected_format",
    "forget_removed_indexes",
    "upload_format",
]
