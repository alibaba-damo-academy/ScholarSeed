"""OOXML DOCX selection evidence processor."""

from __future__ import annotations

import re
from collections.abc import Mapping
from io import BytesIO
from typing import Any
from zipfile import BadZipFile

from docx import Document as load_document
from docx.document import Document
from docx.opc.exceptions import PackageNotFoundError

FORMAT = "docx"
SUFFIX = ".docx"
PARAGRAPH_PATTERN = re.compile(r"^paragraph-(\d+)$")
MAXIMUM_CONTEXT_CHARS = 36_000


class DocxSelectionError(ValueError):
    """A DOCX locator cannot be resolved against OOXML source bytes."""


def _integer(locator: Mapping[str, Any], key: str) -> int:
    value = locator.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise DocxSelectionError(key)
    return value


def _string(locator: Mapping[str, Any], key: str) -> str:
    value = locator.get(key)
    if not isinstance(value, str) or not value:
        raise DocxSelectionError(key)
    return value


def _utf16_slice(text: str, start: int, end: int) -> str:
    if start < 0 or end < start:
        raise DocxSelectionError("utf16_range")
    encoded = text.encode("utf-16-le")
    start_byte = start * 2
    end_byte = end * 2
    if end_byte > len(encoded):
        raise DocxSelectionError("utf16_range")
    try:
        return encoded[start_byte:end_byte].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise DocxSelectionError("utf16_boundary") from exc


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _document(payload: bytes) -> Document:
    try:
        return load_document(BytesIO(payload))
    except (BadZipFile, KeyError, PackageNotFoundError, ValueError) as exc:
        raise DocxSelectionError("writer_document") from exc


def resolve_selection(payload: bytes, locator: Mapping[str, Any]) -> str:
    start_match = PARAGRAPH_PATTERN.fullmatch(_string(locator, "paragraph"))
    end_match = PARAGRAPH_PATTERN.fullmatch(
        str(locator.get("end_paragraph") or locator.get("paragraph") or "")
    )
    if start_match is None or end_match is None:
        raise DocxSelectionError("writer_paragraph")
    start_index = int(start_match.group(1)) - 1
    end_index = int(end_match.group(1)) - 1
    if end_index < start_index:
        raise DocxSelectionError("writer_paragraph")
    paragraphs = _document(payload).paragraphs[start_index : end_index + 1]
    if len(paragraphs) != end_index - start_index + 1:
        raise DocxSelectionError("writer_document")
    start = _integer(locator, "start")
    end = _integer(locator, "end")
    if start_index == end_index:
        return _utf16_slice(paragraphs[0].text, start, end)
    selected = [_utf16_slice(paragraphs[0].text, start, _utf16_length(paragraphs[0].text))]
    selected.extend(paragraph.text for paragraph in paragraphs[1:-1])
    selected.append(_utf16_slice(paragraphs[-1].text, 0, end))
    return "\n".join(selected)


def resolve_context(payload: bytes, _locator: Mapping[str, Any], selected: str) -> str:
    text = "\n".join(paragraph.text for paragraph in _document(payload).paragraphs)
    if len(text) <= MAXIMUM_CONTEXT_CHARS:
        return text
    index = text.find(selected)
    if index < 0:
        return text[:MAXIMUM_CONTEXT_CHARS]
    start = max(0, index - (MAXIMUM_CONTEXT_CHARS - len(selected)) // 2)
    return text[start : start + MAXIMUM_CONTEXT_CHARS]
