"""标题和作者仅读取 PDF metadata，论文标识由独立提取器解析。"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pymupdf

from service.literature.service.identifiers import extract_identifiers

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
        with pymupdf.open(stream=content, filetype="pdf") as document:
            if not document.is_pdf or document.needs_pass:
                raise InvalidPdfError("invalid_pdf")
            metadata = document.metadata or {}
            arxiv, doi = extract_identifiers(document)
            title = _metadata_title(str(metadata.get("title") or ""))
            author = ", ".join(_authors(str(metadata.get("author") or "")))
            return ExtractedMetadata(
                title=title,
                author=author,
                source="metadata",
                arxiv=arxiv,
                doi=doi,
            )
    except (pymupdf.FileDataError, RuntimeError, ValueError) as exc:
        raise InvalidPdfError("invalid_pdf") from exc


__all__ = ["ExtractedMetadata", "InvalidPdfError", "extract_pdf_metadata"]
