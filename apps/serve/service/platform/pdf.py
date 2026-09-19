"""Resolve immutable PDF text selections from normalized viewer coordinates."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Mapping, Sequence
from typing import Any

import pymupdf

from service.platform.records import EMPTY_RECORDS, decode_records

PDF_ANNOTATIONS_ATTACHMENT = "scholarseed-annotations.json"
MAX_PDF_ANNOTATIONS_BYTES = 10 * 1024 * 1024

PDF_LOCATOR = "pdf"
REVISION_PREFIX = "sha256:"
UTF8_ENCODING = "utf-8"
NORMALIZED_COORDINATE_MINIMUM = 0.0
NORMALIZED_COORDINATE_MAXIMUM = 1.0
PDF_WORD_X0 = 0
PDF_WORD_Y0 = 1
PDF_WORD_X1 = 2
PDF_WORD_Y1 = 3
PDF_WORD_TEXT = 4
PDF_WORD_BLOCK = 5
PDF_WORD_LINE = 6
PDF_VISUAL_LINE_MINIMUM_OVERLAP_RATIO = 0.5
PDF_TEXT_WORDS = "words"
PDF_TEXT_RAW_DICTIONARY = "rawdict"
PDF_RAW_BLOCKS = "blocks"
PDF_RAW_LINES = "lines"
PDF_RAW_SPANS = "spans"
PDF_RAW_CHARACTERS = "chars"
PDF_RAW_CHARACTER_TEXT = "c"
PDF_RAW_BOUNDS = "bbox"
MAXIMUM_SELECTION_CHARS = 36_000
TEXT_SHAPE_HASH_KEY = "text_shape_hash"
HASH_PREFIX_LENGTH = len(REVISION_PREFIX)
SHA256_HEX_LENGTH = hashlib.sha256().digest_size * 2
HEX_DIGITS = frozenset("0123456789abcdef")
CJK_SHAPE_MARKER = "中"
CJK_CODE_POINT_RANGES = (
    (0x2E80, 0x2FFF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
    (0x30000, 0x323AF),
)

_log = logging.getLogger(__name__)


class PdfAnnotationError(ValueError):
    """Embedded ScholarSeed records exist but cannot be restored safely."""


def embedded_pdf_records(payload: bytes) -> dict[str, Any]:
    """Read only ScholarSeed's canonical attachment, not native third-party annotations.

    Container validity remains owned by the PDF viewer/attachment validator.
    Opaque resources accepted by the existing record API carry no embedded records.
    Invalid embedded records are ignored rather than blocking the owning PDF flow.
    This boundary does not migrate or partially recover unsupported payloads.
    """
    try:
        document = pymupdf.open(stream=payload, filetype=PDF_LOCATOR)
    except (pymupdf.FileDataError, pymupdf.EmptyFileError):
        return decode_records(EMPTY_RECORDS)
    with document:
        try:
            if document.needs_pass:
                raise PdfAnnotationError("pdf_password_required")
            names = document.embfile_names()
            matches = [name for name in names if name == PDF_ANNOTATIONS_ATTACHMENT]
            if not matches:
                return decode_records(EMPTY_RECORDS)
            if len(matches) != 1:
                raise PdfAnnotationError("duplicate PDF annotation attachments")
            info = document.embfile_info(PDF_ANNOTATIONS_ATTACHMENT)
            if info["size"] > MAX_PDF_ANNOTATIONS_BYTES:
                raise PdfAnnotationError("PDF annotation attachment too large")
            attached = document.embfile_get(PDF_ANNOTATIONS_ATTACHMENT)
            if len(attached) > MAX_PDF_ANNOTATIONS_BYTES:
                raise PdfAnnotationError("PDF annotation attachment too large")
            records = decode_records(attached)
            if any(mark["page"] > document.page_count for mark in records["marks"]):
                raise PdfAnnotationError("PDF annotation page out of range")
            return records
        except (RuntimeError, TypeError, ValueError, KeyError) as error:
            _log.warning(
                "Ignoring invalid embedded ScholarSeed PDF annotations (%s): %s",
                type(error).__name__,
                error,
            )
            return decode_records(EMPTY_RECORDS)


class PdfSelectionError(ValueError):
    """A PDF selection locator cannot be verified against its source bytes."""


def _text_digest(text: str) -> str:
    return f"{REVISION_PREFIX}{hashlib.sha256(text.encode(UTF8_ENCODING)).hexdigest()}"


def pdf_selection_shape(text: str) -> str:
    """Keep layout and non-CJK content while abstracting extractor-specific CJK maps."""

    return "".join(
        (
            CJK_SHAPE_MARKER
            if any(first <= ord(character) <= last for first, last in CJK_CODE_POINT_RANGES)
            else character
        )
        for character in text
    )


def _shape_digest(locator: Mapping[str, Any]) -> str | None:
    value = locator.get(TEXT_SHAPE_HASH_KEY)
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value.startswith(REVISION_PREFIX)
        or len(value) != HASH_PREFIX_LENGTH + SHA256_HEX_LENGTH
        or not set(value[HASH_PREFIX_LENGTH:]) <= HEX_DIGITS
    ):
        raise PdfSelectionError(TEXT_SHAPE_HASH_KEY)
    return value


def pdf_selection_matches(
    text: str,
    locator: Mapping[str, Any],
    expected_hash: str,
) -> bool:
    """Verify exact PDF text, or its explicit cross-extractor CJK structure."""

    if _text_digest(text) == expected_hash:
        return True
    expected_shape = _shape_digest(locator)
    return expected_shape is not None and _text_digest(pdf_selection_shape(text)) == expected_shape


def _integer(locator: Mapping[str, Any], key: str) -> int:
    value = locator.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise PdfSelectionError(key)
    return value


def _quad_rect(quad: object, page: pymupdf.Page) -> pymupdf.Rect:
    if not isinstance(quad, Sequence) or isinstance(quad, (str, bytes)) or len(quad) != 4:
        raise PdfSelectionError("pdf_quad")
    coordinates: list[float] = []
    for value in quad:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PdfSelectionError("pdf_quad")
        coordinate = float(value)
        if not NORMALIZED_COORDINATE_MINIMUM <= coordinate <= NORMALIZED_COORDINATE_MAXIMUM:
            raise PdfSelectionError("pdf_quad")
        coordinates.append(coordinate)
    left, top, right, bottom = coordinates
    if right <= left or bottom <= top:
        raise PdfSelectionError("pdf_quad")
    return pymupdf.Rect(
        page.rect.x0 + left * page.rect.width,
        page.rect.y0 + top * page.rect.height,
        page.rect.x0 + right * page.rect.width,
        page.rect.y0 + bottom * page.rect.height,
    )


def _intersects(left: pymupdf.Rect, right: pymupdf.Rect) -> bool:
    overlap = left & right
    return not overlap.is_empty and overlap.width > 0 and overlap.height > 0


def _same_vertical_band(top: float, bottom: float, other_top: float, other_bottom: float) -> bool:
    overlap = min(bottom, other_bottom) - max(top, other_top)
    minimum_height = min(bottom - top, other_bottom - other_top)
    return (
        overlap > 0
        and minimum_height > 0
        and overlap / minimum_height >= PDF_VISUAL_LINE_MINIMUM_OVERLAP_RATIO
    )


def _same_pdf_visual_line(word: Sequence[Any], top: float, bottom: float) -> bool:
    return _same_vertical_band(
        top,
        bottom,
        float(word[PDF_WORD_Y0]),
        float(word[PDF_WORD_Y1]),
    )


def _pdf_visual_lines(words: Sequence[Sequence[Any]]) -> str:
    lines: list[str] = []
    current: list[str] = []
    line_top = 0.0
    line_bottom = 0.0
    for word in words:
        word_top = float(word[PDF_WORD_Y0])
        word_bottom = float(word[PDF_WORD_Y1])
        if current and not _same_pdf_visual_line(word, line_top, line_bottom):
            lines.append(" ".join(current))
            current = []
        if not current:
            line_top = word_top
            line_bottom = word_bottom
        else:
            line_top = min(line_top, word_top)
            line_bottom = max(line_bottom, word_bottom)
        current.append(str(word[PDF_WORD_TEXT]))
    if current:
        lines.append(" ".join(current))
    return "\n".join(lines)


def _pdf_character_selected(bounds: Sequence[Any], rects: Sequence[pymupdf.Rect]) -> bool:
    if len(bounds) != 4:
        return False
    left, top, right, bottom = (float(value) for value in bounds)
    center = (left + right) / 2
    return any(
        rect.x0 <= center <= rect.x1 and _same_vertical_band(top, bottom, rect.y0, rect.y1)
        for rect in rects
    )


def _pdf_character_text(page: pymupdf.Page, rects: Sequence[pymupdf.Rect]) -> str:
    fragments: list[tuple[float, float, float, str]] = []
    raw = page.get_text(PDF_TEXT_RAW_DICTIONARY, sort=True)
    for block in raw.get(PDF_RAW_BLOCKS, ()):
        for line in block.get(PDF_RAW_LINES, ()):
            characters: list[tuple[Sequence[Any], str]] = []
            for span in line.get(PDF_RAW_SPANS, ()):
                for character in span.get(PDF_RAW_CHARACTERS, ()):
                    bounds = character.get(PDF_RAW_BOUNDS, ())
                    text = character.get(PDF_RAW_CHARACTER_TEXT, "")
                    if text and len(bounds) == 4:
                        characters.append((bounds, str(text)))
            selected = [
                index
                for index, (bounds, _) in enumerate(characters)
                if _pdf_character_selected(bounds, rects)
            ]
            text = (
                "".join(value for _, value in characters[selected[0] : selected[-1] + 1]).strip()
                if selected
                else ""
            )
            bounds = line.get(PDF_RAW_BOUNDS, ())
            if text and len(bounds) == 4:
                first_bounds = characters[selected[0]][0]
                fragments.append(
                    (
                        float(bounds[PDF_WORD_Y0]),
                        float(bounds[PDF_WORD_Y1]),
                        float(first_bounds[PDF_WORD_X0]),
                        text,
                    )
                )

    rows: list[str] = []
    current: list[tuple[float, str]] = []
    row_top = 0.0
    row_bottom = 0.0
    for top, bottom, text_left, text in fragments:
        if current and not _same_vertical_band(row_top, row_bottom, top, bottom):
            rows.append(" ".join(value for _, value in sorted(current)))
            current = []
        if not current:
            row_top = top
            row_bottom = bottom
        else:
            row_top = min(row_top, top)
            row_bottom = max(row_bottom, bottom)
        current.append((text_left, text))
    if current:
        rows.append(" ".join(value for _, value in sorted(current)))
    return "\n".join(rows)


def _pdf_candidates(words: Sequence[Sequence[Any]]) -> tuple[str, ...]:
    word_text = [str(word[PDF_WORD_TEXT]) for word in words]
    spaced = " ".join(word_text)
    compact = "".join(word_text)
    lines: list[str] = []
    current: list[str] = []
    prior_line: tuple[object, object] | None = None
    for word in words:
        line = (word[PDF_WORD_BLOCK], word[PDF_WORD_LINE])
        if prior_line is not None and line != prior_line:
            lines.append(" ".join(current))
            current = []
        current.append(str(word[PDF_WORD_TEXT]))
        prior_line = line
    if current:
        lines.append(" ".join(current))
    logical_multiline = "\n".join(lines)
    visual_multiline = _pdf_visual_lines(words)
    return tuple(dict.fromkeys((spaced, visual_multiline, logical_multiline, compact)))


def resolve_pdf_selection(
    payload: bytes,
    locator: Mapping[str, Any],
    expected_hash: str,
) -> str:
    """Resolve text or a verified CJK shape inside the bounded PDF coordinates."""

    page_number = _integer(locator, "page")
    expected_shape = _shape_digest(locator)
    quads = locator.get("quads")
    if page_number < 1 or not isinstance(quads, Sequence) or isinstance(quads, (str, bytes)):
        raise PdfSelectionError("pdf_location")
    try:
        document = pymupdf.open(stream=payload, filetype=PDF_LOCATOR)
        if page_number > document.page_count:
            raise PdfSelectionError("pdf_page")
        page = document.load_page(page_number - 1)
        rects = tuple(_quad_rect(quad, page) for quad in quads)
        if not rects:
            raise PdfSelectionError("pdf_quads")
        character_text = _pdf_character_text(page, rects)
        words = tuple(
            word
            for word in page.get_text(PDF_TEXT_WORDS, sort=True)
            if any(
                _intersects(
                    pymupdf.Rect(
                        word[PDF_WORD_X0],
                        word[PDF_WORD_Y0],
                        word[PDF_WORD_X1],
                        word[PDF_WORD_Y1],
                    ),
                    rect,
                )
                for rect in rects
            )
        )
    except PdfSelectionError:
        raise
    except (RuntimeError, ValueError) as exc:
        raise PdfSelectionError("pdf_document") from exc
    finally:
        if "document" in locals():
            document.close()
    if not words:
        raise PdfSelectionError("pdf_words")
    candidates = tuple(dict.fromkeys((character_text, *_pdf_candidates(words))))
    if "text_length" in locator:
        length = _integer(locator, "text_length")
        if length < 1 or length > MAXIMUM_SELECTION_CHARS:
            raise PdfSelectionError("pdf_text_length")
        for candidate in candidates:
            for start in range(len(candidate) - length + 1):
                selected = candidate[start : start + length]
                if _text_digest(selected) == expected_hash:
                    return selected
        if expected_shape is not None:
            for candidate in candidates:
                shaped = pdf_selection_shape(candidate)
                for start in range(len(shaped) - length + 1):
                    if _text_digest(shaped[start : start + length]) == expected_shape:
                        return candidate[start : start + length]
    return next(
        (candidate for candidate in candidates if _text_digest(candidate) == expected_hash),
        candidates[0],
    )


__all__ = [
    "PDF_LOCATOR",
    "PdfAnnotationError",
    "embedded_pdf_records",
    "PdfSelectionError",
    "pdf_selection_matches",
    "pdf_selection_shape",
    "resolve_pdf_selection",
]
