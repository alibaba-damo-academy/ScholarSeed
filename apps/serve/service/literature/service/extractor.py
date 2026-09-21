"""标题和作者仅读取 PDF metadata，论文标识由独立提取器解析。"""

from __future__ import annotations

import re
from dataclasses import dataclass

from service.literature.service.identifiers import extract_identifiers
from service.platform.pdf import PdfDocumentError, pdf_document_info, pdf_metadata

MIN_METADATA_TITLE_LENGTH = 5
UNTITLED_MARKER = "untitled"
GENERATED_TITLE = re.compile(r"^[^/\\]+\.(?:dvi|pdf|ps|tex)$", flags=re.IGNORECASE)

AUTHOR_SEPARATOR = re.compile(r",|;|&|\band\b", flags=re.IGNORECASE)
AUTHOR_MARKS = re.compile(r"[*†‡§¶#]+$")
AUTHOR_AFFILIATION = re.compile(r"\[\d+\]")


class InvalidPdfError(ValueError):
    """上传内容不是可解析的 PDF。"""


@dataclass(frozen=True)
class ExtractedMetadata:
    """从 PDF 中提取的基础书目信息。"""

    title: str
    author: str
    source: str
    arxiv: str = ""
    doi: str = ""


def _authors(raw: str) -> tuple[str, ...]:
    """清洗并拆分常见 PDF 作者字符串。"""

    names: list[str] = []
    for part in AUTHOR_SEPARATOR.split(raw):
        name = AUTHOR_MARKS.sub("", part.strip())
        name = AUTHOR_AFFILIATION.sub("", name).strip()
        if len(name) > 1 and name not in names:
            names.append(name)
    return tuple(names)


def _metadata_title(raw: str) -> str:
    """仅保留可作为书目标题使用的 PDF 内嵌标题。"""

    title = raw.strip()
    if (
        len(title) <= MIN_METADATA_TITLE_LENGTH
        or UNTITLED_MARKER in title.lower()
        or GENERATED_TITLE.fullmatch(title)
    ):
        return ""
    return title


def extract_pdf_metadata(content: bytes) -> ExtractedMetadata:
    """提取标题、作者与论文标识；缺失的字段留空，由导入入口处理标题兜底。"""

    try:
        if pdf_document_info(content).page_count < 1:
            raise InvalidPdfError("invalid_pdf")
        metadata = pdf_metadata(content)
        arxiv, doi = extract_identifiers(content)
        return ExtractedMetadata(
            title=_metadata_title(metadata.title),
            author=", ".join(_authors(metadata.author)),
            source="metadata",
            arxiv=arxiv,
            doi=doi,
        )
    except (PdfDocumentError, RuntimeError, ValueError) as exc:
        raise InvalidPdfError("invalid_pdf") from exc


__all__ = ["ExtractedMetadata", "InvalidPdfError", "extract_pdf_metadata"]
