"""Format-aware text extraction from Content-owned stable bytes."""

from __future__ import annotations

from collections.abc import Iterable
from io import BytesIO
from pathlib import PurePosixPath
from zipfile import BadZipFile, LargeZipFile, ZipFile

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from docx.table import Table
from docx.text.paragraph import Paragraph
from lxml.etree import XMLSyntaxError

TEXT_SUFFIXES = frozenset(
    {
        ".bib",
        ".c",
        ".cpp",
        ".csv",
        ".h",
        ".java",
        ".js",
        ".json",
        ".log",
        ".markdown",
        ".md",
        ".py",
        ".r",
        ".sh",
        ".tex",
        ".toml",
        ".ts",
        ".tsv",
        ".tsx",
        ".txt",
        ".xml",
        ".yaml",
        ".yml",
    }
)
DOCX_SUFFIX = ".docx"
UTF8_ENCODING = "utf-8"

# Search reads are intentionally bounded. DOCX limits apply both to the compressed
# source and to archive metadata before python-docx is allowed to expand any part.
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_DOCX_BYTES = 32 * 1024 * 1024
MAX_DOCX_MEMBERS = 2048
MAX_DOCX_PART_BYTES = 16 * 1024 * 1024
MAX_DOCX_EXPANDED_BYTES = 128 * 1024 * 1024
ZIP_ENCRYPTED_FLAG = 1


class ContentExtractionError(ValueError):
    """Stable bytes are malformed or unsafe for the selected extractor."""


def content_limit(path: str) -> int | None:
    """Return the stable-read limit for a directly searchable file."""

    suffix = PurePosixPath(path).suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return MAX_TEXT_BYTES
    if suffix == DOCX_SUFFIX:
        return MAX_DOCX_BYTES
    return None


def _validate_docx(payload: bytes) -> None:
    if len(payload) > MAX_DOCX_BYTES:
        raise ContentExtractionError
    try:
        with ZipFile(BytesIO(payload)) as archive:
            members = archive.infolist()
    except (BadZipFile, LargeZipFile, OSError) as exc:
        raise ContentExtractionError from exc
    if len(members) > MAX_DOCX_MEMBERS:
        raise ContentExtractionError
    expanded = 0
    for member in members:
        if member.flag_bits & ZIP_ENCRYPTED_FLAG:
            raise ContentExtractionError
        if member.file_size > MAX_DOCX_PART_BYTES:
            raise ContentExtractionError
        expanded += member.file_size
        if expanded > MAX_DOCX_EXPANDED_BYTES:
            raise ContentExtractionError


def _block_text(blocks: Iterable[Paragraph | Table]) -> list[str]:
    text: list[str] = []
    for block in blocks:
        if isinstance(block, Paragraph):
            if block.text:
                text.append(block.text)
            continue
        for row in block.rows:
            for cell in row.cells:
                text.extend(_block_text(cell.iter_inner_content()))
    return text


def decode_docx(payload: bytes) -> str:
    """Extract common visible DOCX text from body, tables, headers and footers."""

    _validate_docx(payload)
    try:
        document = Document(BytesIO(payload))
        text = _block_text(document.iter_inner_content())
        seen_parts: set[str] = set()
        for section in document.sections:
            containers = (
                section.header,
                section.first_page_header,
                section.even_page_header,
                section.footer,
                section.first_page_footer,
                section.even_page_footer,
            )
            for container in containers:
                part = str(container.part.partname)
                if part in seen_parts:
                    continue
                seen_parts.add(part)
                text.extend(_block_text(container.iter_inner_content()))
        return "\n".join(text)
    except (
        BadZipFile,
        KeyError,
        LargeZipFile,
        OSError,
        PackageNotFoundError,
        ValueError,
        XMLSyntaxError,
    ) as exc:
        raise ContentExtractionError from exc


def extract_text(path: str, payload: bytes) -> str:
    """Decode supported stable bytes; reject unsupported file types explicitly."""

    suffix = PurePosixPath(path).suffix.lower()
    if suffix in TEXT_SUFFIXES:
        try:
            return payload.decode(UTF8_ENCODING)
        except UnicodeDecodeError as exc:
            raise ContentExtractionError from exc
    if suffix == DOCX_SUFFIX:
        return decode_docx(payload)
    raise ContentExtractionError


__all__ = [
    "ContentExtractionError",
    "DOCX_SUFFIX",
    "MAX_DOCX_BYTES",
    "MAX_TEXT_BYTES",
    "TEXT_SUFFIXES",
    "content_limit",
    "decode_docx",
    "extract_text",
]
