"""Canonical format policy and exact content access for literature attachments."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any

from service.content.domain.model import ContentError
from service.literature.persistence.files import (
    LiteratureFileBatch,
    delete_attachments,
    is_available_attachment,
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
    AttachmentRole,
    LiteratureAttachment,
    LiteratureItem,
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
#: 「已有可用主附件」的产品失败码。名字带 arXiv 是历史包袱 (它最早只由 arXiv 下载腿
#: 抛出), 但值已经是前端 i18n 与渲染层错误映射的键 (locales/*/literature.json 的
#: operationError.ARXIV_ALREADY_ATTACHED), 所以口径统一到这里之后仍原样保留。
ARXIV_ALREADY_ATTACHED = "ARXIV_ALREADY_ATTACHED"
PDF_SUFFIX = ".pdf"
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
        return self.location_attachment(self.attachment(literature_id, attachment_id))

    def read_absolute(self, location: str) -> tuple[bytes, str]:
        """Serve one owned file to Content's absolute-path citation reader.

        这条入口收的是"会话里按绝对路径引用的文件", 所以先确认这个路径确实登记在某条
        附件行上, 否则等于把托管目录之外的任意路径也放开了。
        """

        # Resolving first would authorize an unregistered alias of a registered file.
        if not is_managed_attachment(location) or not self._repository.has_attachment_path(
            location
        ):
            raise ContentError(PATH_NOT_AUTHORIZED)
        try:
            payload = read_attachment(location)
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


class AttachmentConflictError(ValueError):
    """主附件不变式被违反: 已有可用主附件时不许再挂一份。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AttachedFulltext:
    """一次主附件挂载的结果: 落库后的条目与它新的附件行。"""

    item: LiteratureItem
    attachment: dict[str, Any]


def has_usable_primary(item_id: str, repository: LiteratureRepository | None = None) -> bool:
    """全域唯一判据: 主附件行存在, 且它指的字节还在。

    行在而字节丢 (availability=missing) 不算「有全文」: 那是需要补救的状态, 不是需要
    拒绝的状态。下载腿用它决定要不要提前 409 (别白下一次), ``attach_primary_pdf`` 用它
    守不变式, 两处必须是同一个判据。
    """

    store = repository or LiteratureRepository()
    existing = store.primary_attachment(item_id)
    return existing is not None and is_available_attachment(existing.path)


def attach_primary_pdf(
    item: LiteratureItem,
    name: str,
    payload: bytes,
    *,
    declared_media_type: str = "",
    pdf_indexes: PdfIndexForgetPort | None = None,
    items: Sequence[LiteratureItem] = (),
    repository: LiteratureRepository | None = None,
) -> AttachedFulltext:
    """把一份 PDF 挂成这条文献的主附件; 产品上传、下载腿与 bridge 共用这一个入口。

    不变式: **已有可用主附件时任何入口都不能再挂一份**, 所以这里没有 ``replace`` 开关。
    挂新主附件会把旧行降级成补充材料 (``store.add_attachment``), 等于把用户已有的全文
    悄悄换掉 —— UI 也从不提供这个操作 (唯一的 primary 入口只在无全文卡里), 因此这条判据
    无条件执行, 违反就抛 :class:`AttachmentConflictError`。

    唯一允许覆盖的是旧主附件已经不可用 (行在、字节丢) 的情况: 此时在同一批次里**删掉**
    旧行而不是降级, 否则附件列表会永久留一条 missing 的补充材料。删除必须连带独占字节
    与派生全文索引 (``delete_attachments`` + ``forget_removed_indexes``), 因为索引只能靠
    附件行存下的 revision 指认。

    ``items`` 是同一批次里要一起落库的条目 (下载腿用它回写 arXiv/DOI), 留空则只写附件行。
    ``repository`` 必须与调用方解析 ``item`` 用的是同一个 store: 条目在哪本账上读出来,
    附件行就要写进哪本账, 否则挂载会落到另一个库里 (生产环境只有一个库, 差别只在测试)。
    """

    attachment_format = upload_format(name, payload, declared_media_type)
    if attachment_format.media_type != PDF_MEDIA_TYPE:
        # 主附件只允许 PDF: 这是全文记账的前提 (store 只在 PRIMARY + PDF 时置 READY)。
        raise AttachmentFormatError(ATTACHMENT_TYPE_MISMATCH)
    store = repository or LiteratureRepository()
    existing = store.primary_attachment(item.id)
    if existing is not None and is_available_attachment(existing.path):
        raise AttachmentConflictError(ARXIV_ALREADY_ATTACHED)
    published = managed_object(item.id, payload, PDF_SUFFIX)
    with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
        location = batch.stage(published.name, payload)

        def write() -> AttachedFulltext:
            if existing is not None:
                store.delete_attachment(item.id, existing.id)
            saved = store.save_all(tuple(items)) if items else ()
            attachment = store.add_attachment(
                item.id,
                name,
                location,
                attachment_format.kind,
                revision=published.revision,
                role=AttachmentRole.PRIMARY,
                media_type=attachment_format.media_type,
            )
            return AttachedFulltext(item=saved[0] if saved else item, attachment=attachment)

        # 附件行必须在批次提交内写: 落库失败时批次会回滚已搬过去的文件, 否则托管目录里
        # 会留下没有任何行指向的孤儿 PDF。
        attached = batch.commit_operation(write)
    if existing is not None:
        try:
            delete_attachments((existing.path,))
        except OSError:
            LOGGER.warning("failed to remove superseded primary attachment")
        forget_removed_indexes(pdf_indexes, (existing.revision,))
    return attached


__all__ = [
    "ARXIV_ALREADY_ATTACHED",
    "ATTACHMENT_FORMATS",
    "ATTACHMENT_INVALID",
    "ATTACHMENT_MISSING",
    "ATTACHMENT_TYPE_MISMATCH",
    "ATTACHMENT_UNREADABLE",
    "REVISION_CONFLICT",
    "AttachedFulltext",
    "AttachmentConflictError",
    "AttachmentFormat",
    "AttachmentFormatError",
    "LiteratureAttachmentContent",
    "attach_primary_pdf",
    "detected_format",
    "forget_removed_indexes",
    "has_usable_primary",
    "upload_format",
]
