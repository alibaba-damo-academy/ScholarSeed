"""Workbench 打开协议与能力判定 (workbench 域, 开发 4 拥有)。

架构文档 §3.4 把 `OpenDocumentRequest` 与 `DocumentCapabilities` 定为本域产出,
§4.3 则明令**不得在 App Shell 里按文件扩展名写硬编码分支**。

这两条合起来决定了本文件的存在理由: 扩展名 → 能力的判定必须有唯一归属地。
放在后端而不是前端, 是因为「这份文件能不能编辑/能不能出 diff」取决于
documents 域真正实现了什么, 前端猜不准 —— 猜错就会给用户一个点了没反应的按钮。

前端拿到 `DocumentCapabilities` 后只做「有能力就渲染对应控件」, 不再判断类型。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from service.content.service.sheet import SpreadsheetInspection
from service.content.service.spreadsheet import processor_for
from service.platform.content import FileAssetRef
from service.platform.resources import ResourceFormatPolicy
from service.platform.workbench import DocumentFormatProjection


class ViewerKind(str, Enum):
    """Viewer 插件种类。与前端 `ViewerPlugin` 注册名一一对应。"""

    MARKDOWN = "markdown"
    PDF = "pdf"
    TABLE = "table"
    CODE = "code"
    IMAGE = "image"
    OFFICE = "office"
    SPREADSHEET = "spreadsheet"
    #: 无法预览的二进制。
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class FormatRegistration:
    """One registered Workbench format with version and editing policy."""

    viewer: ViewerKind
    versionable: bool = False
    readonly: bool = False
    artifact_editable: bool = False


class ContentKind(str, Enum):
    """Byte-level file classification, independent from the selected viewer."""

    TEXT = "text"
    BINARY = "binary"
    OVERSIZED = "oversized"


NUL_BYTE = b"\x00"
UTF8_ENCODING = "utf-8"
BINARY_PREVIEW_UNSUPPORTED = "binary_preview_unsupported"
FILE_TOO_LARGE = "file_too_large"
TEXT_VIEWER_KINDS = {ViewerKind.MARKDOWN, ViewerKind.CODE}
MEBIBYTE = 1024 * 1024
WORKBENCH_PREVIEW_MAX_BYTES = 500 * MEBIBYTE


#: 扩展名 → 格式能力。Viewer 和版本白名单共用这一份声明式注册表。
#:
#: 新格式默认只获得预览能力；必须显式设置 ``versionable=True`` 才会进入
#: 资源版本扫描，防止 Viewer 扩展把大量项目文件隐式纳入版本管理。
FORMAT_BY_SUFFIX: dict[str, FormatRegistration] = {
    ".md": FormatRegistration(ViewerKind.MARKDOWN, versionable=True),
    ".markdown": FormatRegistration(ViewerKind.MARKDOWN, versionable=True),
    ".txt": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".pdf": FormatRegistration(ViewerKind.PDF, versionable=True),
    ".csv": FormatRegistration(ViewerKind.SPREADSHEET, versionable=True, readonly=True),
    ".tsv": FormatRegistration(ViewerKind.TABLE, versionable=True),
    ".json": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".jsonl": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".yaml": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".yml": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".py": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".r": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".java": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".c": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".cpp": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".h": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".sh": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".toml": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".xml": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".log": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".jsx": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".ts": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".tsx": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".js": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".css": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".html": FormatRegistration(ViewerKind.CODE, versionable=True),
    ".png": FormatRegistration(ViewerKind.IMAGE),
    ".jpg": FormatRegistration(ViewerKind.IMAGE),
    ".jpeg": FormatRegistration(ViewerKind.IMAGE),
    ".webp": FormatRegistration(ViewerKind.IMAGE),
    ".gif": FormatRegistration(ViewerKind.IMAGE),
    ".svg": FormatRegistration(ViewerKind.IMAGE),
    ".doc": FormatRegistration(ViewerKind.OFFICE, versionable=True, readonly=True),
    ".docx": FormatRegistration(ViewerKind.OFFICE, versionable=True, readonly=True),
    ".xls": FormatRegistration(ViewerKind.OFFICE, versionable=True, readonly=True),
    ".xlsx": FormatRegistration(
        ViewerKind.SPREADSHEET,
        versionable=True,
        readonly=True,
        artifact_editable=True,
    ),
    ".ppt": FormatRegistration(ViewerKind.OFFICE, versionable=True, readonly=True),
    ".pptx": FormatRegistration(ViewerKind.OFFICE, versionable=True, readonly=True),
}

#: Compatibility projection for callers that only need Viewer routing.
VIEWER_BY_SUFFIX: dict[str, ViewerKind] = {
    suffix: registration.viewer for suffix, registration in FORMAT_BY_SUFFIX.items()
}


@dataclass(frozen=True)
class DocumentCapabilities:
    """Capabilities returned by the Workbench format registry."""

    can_edit: bool
    can_version: bool
    can_diff: bool
    can_preview: bool = True
    can_select: bool = False
    can_annotate: bool = False
    can_save: bool = False
    pending: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class OpenDocumentRequest:
    """打开一份文档的请求 (架构文档 §3.4 对外协议)。

    资料库与文献库只发这个请求, **不直接控制 Viewer** —— 因此两个库都不需要
    知道 PDF 用什么渲染、Markdown 用哪个编辑器。
    """

    project_id: str
    #: 项目内相对路径, 与 `FileAssetRef.path` 同一套语义。
    path: str
    #: 面向用户的标签名。
    title: str
    #: 打开后应聚焦的位置 (从搜索/引用跳转时用)。
    page: int | None = None


def format_for(path: str) -> FormatRegistration | None:
    """Resolve one explicitly registered suffix without guessing from contents."""

    lowered = path.lower()
    for suffix, registration in FORMAT_BY_SUFFIX.items():
        if lowered.endswith(suffix):
            return registration
    return None


def content_kind_for(payload: bytes) -> ContentKind:
    """Classify bounded bytes without replacing undecodable content."""

    if NUL_BYTE in payload:
        return ContentKind.BINARY
    try:
        payload.decode(UTF8_ENCODING)
    except UnicodeDecodeError:
        return ContentKind.BINARY
    return ContentKind.TEXT


def viewer_for(path: str, payload: bytes | None = None) -> ViewerKind:
    """路径与受限内容 → Viewer 种类；未知 UTF-8 文本使用基础代码预览。"""

    registration = format_for(path)
    if registration is not None:
        if (
            payload is not None
            and registration.viewer in TEXT_VIEWER_KINDS
            and content_kind_for(payload) is ContentKind.BINARY
        ):
            return ViewerKind.UNSUPPORTED
        return registration.viewer
    if payload is not None and content_kind_for(payload) is ContentKind.TEXT:
        return ViewerKind.CODE
    return ViewerKind.UNSUPPORTED


def capabilities_for(path: str, payload: bytes | None = None) -> DocumentCapabilities:
    """路径 → 这份文档真正支持的能力。

    原生修订和文本行级比较是独立能力；格式不支持时明确返回 false。
    """

    registration = format_for(path)
    registered = viewer_for(path)
    kind = viewer_for(path, payload)
    if registered is ViewerKind.UNSUPPORTED and kind is ViewerKind.CODE:
        return DocumentCapabilities(
            can_edit=True,
            can_version=False,
            can_diff=False,
            can_select=True,
            can_save=True,
        )
    if kind is ViewerKind.MARKDOWN:
        return DocumentCapabilities(
            can_edit=True,
            can_version=True,
            can_diff=True,
            can_select=True,
            can_save=True,
        )
    if kind is ViewerKind.CODE:
        return DocumentCapabilities(
            can_edit=True,
            can_version=True,
            can_diff=True,
            can_select=True,
            can_save=True,
        )
    if kind is ViewerKind.PDF:
        return DocumentCapabilities(
            can_edit=False,
            can_version=True,
            can_diff=False,
            can_select=True,
            can_annotate=True,
        )
    if kind is ViewerKind.OFFICE:
        editable = not bool(registration and registration.readonly)
        return DocumentCapabilities(
            can_edit=editable,
            can_version=True,
            can_diff=False,
            can_select=True,
            can_save=editable,
        )
    if kind is ViewerKind.SPREADSHEET:
        processor = processor_for(path)
        inspection = (
            processor.inspect(payload or b"")
            if processor is not None and processor.inspect is not None
            else SpreadsheetInspection(False, BINARY_PREVIEW_UNSUPPORTED)
        )
        editable = inspection.editable and not bool(registration and registration.readonly)
        return DocumentCapabilities(
            can_edit=editable,
            can_version=bool(registration and registration.versionable),
            can_diff=False,
            can_select=True,
            can_save=editable,
            pending=(inspection.reason,) if inspection.reason else (),
        )
    if kind is ViewerKind.UNSUPPORTED:
        return DocumentCapabilities(
            can_edit=False,
            can_version=False,
            can_diff=False,
            can_preview=False,
            pending=(BINARY_PREVIEW_UNSUPPORTED,) if payload is not None else (),
        )
    return DocumentCapabilities(can_edit=False, can_version=False, can_diff=False)


class WorkbenchFormatPolicy(ResourceFormatPolicy):
    """Expose the explicit Workbench version allowlist to the supervisor."""

    def versionable(self, path: str) -> bool:
        registration = format_for(path)
        return registration.versionable if registration is not None else False

    def version_patterns(self) -> tuple[str, ...]:
        return tuple(
            f"*{suffix}"
            for suffix, registration in FORMAT_BY_SUFFIX.items()
            if registration.versionable
        )

    def diffable(self, path: str) -> bool:
        return capabilities_for(path).can_diff

    def project(self, path: str, payload: bytes) -> DocumentFormatProjection:
        """Project any source bytes through the one Workbench format registry."""

        registration = format_for(path)
        viewer = viewer_for(path, payload)
        capabilities = capabilities_for(path, payload)
        processor = processor_for(path)
        artifact_editable = bool(
            registration
            and registration.artifact_editable
            and processor is not None
            and processor.inspect is not None
            and processor.inspect(payload).editable
        )
        return DocumentFormatProjection(
            viewer=viewer.value,
            processor=processor.kind.value if processor is not None else None,
            content_kind=content_kind_for(payload).value,
            can_preview=capabilities.can_preview,
            can_edit=capabilities.can_edit,
            can_select=capabilities.can_select,
            can_annotate=capabilities.can_annotate,
            can_save=capabilities.can_save,
            can_edit_artifact=artifact_editable,
            pending=capabilities.pending,
        )

    def preview(self, path: str, payload: bytes) -> bytes:
        """Prepare compatibility bytes only for a readonly spreadsheet preview."""

        processor = processor_for(path)
        if (
            processor is not None
            and processor.inspect is not None
            and processor.preview is not None
            and processor.inspect(payload).reason
        ):
            return processor.preview(payload)
        return payload


def open_request_for(asset: FileAssetRef, *, page: int | None = None) -> OpenDocumentRequest:
    """从资产引用构造打开请求。资料库/文献库共用这一条路径。"""

    return OpenDocumentRequest(
        project_id=asset.project_id,
        path=asset.path,
        title=asset.name,
        page=page,
    )


__all__ = [
    "FORMAT_BY_SUFFIX",
    "VIEWER_BY_SUFFIX",
    "ContentKind",
    "DocumentCapabilities",
    "FormatRegistration",
    "OpenDocumentRequest",
    "ViewerKind",
    "WorkbenchFormatPolicy",
    "capabilities_for",
    "format_for",
    "content_kind_for",
    "open_request_for",
    "viewer_for",
]
