"""Resolve immutable PDF text selections from normalized viewer coordinates."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import os
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from io import BytesIO
from statistics import median
from tempfile import TemporaryFile
from typing import Any

import pdfplumber
from PIL import Image
from pypdf import PasswordType, PdfReader
from pypdf.errors import PdfReadError

from service.platform.records import EMPTY_RECORDS, decode_records

PDF_ANNOTATIONS_ATTACHMENT = "scholarseed-annotations.json"
MAX_PDF_ANNOTATIONS_BYTES = 10 * 1024 * 1024

PDF_LOCATOR = "pdf"
REVISION_PREFIX = "sha256:"
UTF8_ENCODING = "utf-8"
NORMALIZED_COORDINATE_MINIMUM = 0.0
NORMALIZED_COORDINATE_MAXIMUM = 1.0
PDF_VISUAL_LINE_MINIMUM_OVERLAP_RATIO = 0.5
PDF_LAYOUT_PARAMETERS = {"boxes_flow": 0.5, "detect_vertical": True}
PDF_MARGIN_RATIO = 0.1
PDF_REPEATED_TEXT_MINIMUM_CHARS = 8
PDF_WATERMARK_MINIMUM_ANGLE = 15
PDF_WATERMARK_MAXIMUM_ANGLE = 75
PDF_WATERMARK_SIZE_RATIO = 2
PDF_TEXT_BOX_OBJECT = "textboxhorizontal"
PDF_VERTICAL_TEXT_BOX_OBJECT = "textboxvertical"
PDF_TEXT_LINE_OBJECT = "textlinehorizontal"
PDF_VERTICAL_TEXT_LINE_OBJECT = "textlinevertical"
PDF_WORKER_MODULE = "service.platform.pdfium"
PDF_WORKER_TIMEOUT_SECONDS = 180
PDF_WORKER_MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024
PDF_WORKER_MAXIMUM_INPUT_BYTES = 100_000_000
PDF_WORKER_MAXIMUM_STDERR_BYTES = 4096
PDF_WORKER_MAXIMUM_ATTEMPTS = 2
PDF_WORKER_WINDOWS_EXCEPTION_MINIMUM = 0x80000000
PDF_WORKER_OPERATION_OPTION = "--operation"
PDF_WORKER_PARAMETERS_OPTION = "--parameters"
PDF_WORKER_ENV_KEYS = ("PATH", "SYSTEMROOT", "LANG", "LC_ALL", "PYTHONPATH")


class PdfNativeOperation(StrEnum):
    INFO = "info"
    TEXT = "text"
    IMAGES = "images"
    RENDER = "render"


def pdf_worker_crashed(returncode: int) -> bool:
    return returncode < 0 or returncode >= PDF_WORKER_WINDOWS_EXCEPTION_MINIMUM


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


class PdfDocumentError(ValueError):
    """PDF bytes cannot be consumed through the shared product boundary."""


class PdfPasswordError(PdfDocumentError):
    """PDF bytes require a non-empty password."""


@dataclass(frozen=True)
class PdfDocumentInfo:
    page_count: int
    encrypted: bool


@dataclass(frozen=True)
class PdfMetadata:
    title: str
    author: str
    subject: str
    keywords: str
    xmp: str


@dataclass(frozen=True)
class PdfRect:
    x0: float
    top: float
    x1: float
    bottom: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.bottom - self.top

    def intersects(self, other: PdfRect) -> bool:
        return min(self.x1, other.x1) > max(self.x0, other.x0) and min(
            self.bottom, other.bottom
        ) > max(self.top, other.top)

    def union(self, other: PdfRect) -> PdfRect:
        return PdfRect(
            min(self.x0, other.x0),
            min(self.top, other.top),
            max(self.x1, other.x1),
            max(self.bottom, other.bottom),
        )


@dataclass(frozen=True)
class PdfWord:
    text: str
    bounds: PdfRect
    block: int
    line: int


@dataclass(frozen=True)
class PdfCharacter:
    text: str
    bounds: PdfRect


@dataclass(frozen=True)
class PdfTextBlock:
    text: str
    bounds: PdfRect
    vertical: bool = False


@dataclass(frozen=True)
class PdfTextLine:
    text: str
    bounds: PdfRect
    vertical: bool = False


@dataclass(frozen=True)
class PdfLink:
    uri: str
    bounds: PdfRect


@dataclass(frozen=True)
class PdfPageLayout:
    page: int
    width: float
    height: float
    rotation: int
    text: str
    words: tuple[PdfWord, ...]
    characters: tuple[PdfCharacter, ...]
    blocks: tuple[PdfTextBlock, ...]
    lines: tuple[PdfTextLine, ...]
    links: tuple[PdfLink, ...]


def _reader(payload: bytes) -> tuple[PdfReader, bool]:
    try:
        reader = PdfReader(BytesIO(payload), strict=False)
        encrypted = reader.is_encrypted
        if encrypted and reader.decrypt("") is PasswordType.NOT_DECRYPTED:
            raise PdfPasswordError("pdf_password_required")
        return reader, encrypted
    except PdfPasswordError:
        raise
    except (PdfReadError, OSError, TypeError, ValueError) as error:
        raise PdfDocumentError("pdf_document_invalid") from error


def pdf_document_info(payload: bytes) -> PdfDocumentInfo:
    _reader_object, encrypted = _reader(payload)
    page_count = _native_pdf(payload, PdfNativeOperation.INFO)
    if isinstance(page_count, bool) or not isinstance(page_count, int) or page_count < 1:
        raise PdfDocumentError("pdf_worker_invalid_output")
    return PdfDocumentInfo(page_count=page_count, encrypted=encrypted)


def _native_pdf(payload: bytes, operation: PdfNativeOperation, **parameters: Any) -> Any:
    if len(payload) > PDF_WORKER_MAXIMUM_INPUT_BYTES:
        raise PdfDocumentError("pdf_document_too_large")
    command = [
        sys.executable,
        "-B",
        "-m",
        PDF_WORKER_MODULE,
        PDF_WORKER_OPERATION_OPTION,
        operation.value,
        PDF_WORKER_PARAMETERS_OPTION,
        json.dumps(parameters, allow_nan=False),
    ]
    for attempt in range(PDF_WORKER_MAXIMUM_ATTEMPTS):
        with TemporaryFile() as output_file, TemporaryFile() as error_file:
            try:
                with subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=output_file,
                    stderr=error_file,
                    env={
                        name: os.environ[name] for name in PDF_WORKER_ENV_KEYS if name in os.environ
                    },
                ) as process:
                    try:
                        process.communicate(payload, timeout=PDF_WORKER_TIMEOUT_SECONDS)
                    except subprocess.TimeoutExpired as error:
                        process.kill()
                        process.communicate()
                        raise PdfDocumentError("pdf_worker_timeout") from error
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait()
                    returncode = process.returncode
                output_file.seek(0)
                output = output_file.read(PDF_WORKER_MAXIMUM_OUTPUT_BYTES + 1)
                error_file.seek(0, 2)
                error_file.seek(max(0, error_file.tell() - PDF_WORKER_MAXIMUM_STDERR_BYTES))
                diagnostic = error_file.read().decode(UTF8_ENCODING, errors="replace")
            except OSError as error:
                raise PdfDocumentError("pdf_worker_unavailable") from error
        if pdf_worker_crashed(returncode):
            _log.warning(
                "PDF native worker crashed: operation=%s attempt=%s returncode=%s stderr=%s",
                operation.value,
                attempt + 1,
                returncode,
                diagnostic,
            )
            if attempt + 1 < PDF_WORKER_MAXIMUM_ATTEMPTS:
                continue
            raise PdfDocumentError("pdf_worker_crashed")
        if len(output) > PDF_WORKER_MAXIMUM_OUTPUT_BYTES:
            raise PdfDocumentError("pdf_worker_output_too_large")
        try:
            response = json.loads(output)
        except (ValueError, UnicodeDecodeError) as error:
            raise PdfDocumentError("pdf_worker_invalid_output") from error
        if not isinstance(response, dict):
            raise PdfDocumentError("pdf_worker_invalid_output")
        if response.get("ok") is False and isinstance(response.get("error"), str):
            if response["error"] == "pdf_password_required":
                raise PdfPasswordError(response["error"])
            raise PdfDocumentError(response["error"])
        if returncode or response.get("ok") is not True or "result" not in response:
            raise PdfDocumentError("pdf_worker_invalid_output")
        return response["result"]
    raise PdfDocumentError("pdf_worker_crashed")


def _metadata_text(value: object) -> str:
    return str(value or "").strip()


def pdf_metadata(payload: bytes) -> PdfMetadata:
    reader, _encrypted = _reader(payload)
    metadata: Mapping[str, Any] = reader.metadata or {}
    try:
        xmp = reader.xmp_metadata
        xmp_text = xmp.stream.get_data().decode(UTF8_ENCODING, errors="replace") if xmp else ""
    except (PdfReadError, OSError, TypeError, ValueError) as error:
        _log.warning("Ignoring malformed PDF XMP metadata: %s", error)
        xmp_text = ""
    return PdfMetadata(
        title=_metadata_text(metadata.get("/Title")),
        author=_metadata_text(metadata.get("/Author")),
        subject=_metadata_text(metadata.get("/Subject")),
        keywords=_metadata_text(metadata.get("/Keywords")),
        xmp=xmp_text,
    )


def _rect(item: Mapping[str, Any]) -> PdfRect:
    return PdfRect(
        float(item.get("x0", 0.0)),
        float(item.get("top", 0.0)),
        float(item.get("x1", 0.0)),
        float(item.get("bottom", 0.0)),
    )


def _decoration_candidates(page) -> set[tuple[str, str]]:
    candidates: set[tuple[str, str]] = set()
    sizes = [float(char["size"]) for char in page.chars if char.get("text", "").strip()]
    if not sizes:
        return candidates
    body_size = median(sizes)
    watermark = []
    for char in page.chars:
        matrix = char.get("matrix", (1, 0, 0, 1, 0, 0))
        angle = abs(math.degrees(math.atan2(matrix[1], matrix[0]))) % 180
        angle = min(angle, 180 - angle)
        if (
            PDF_WATERMARK_MINIMUM_ANGLE <= angle <= PDF_WATERMARK_MAXIMUM_ANGLE
            and float(char["size"]) >= body_size * PDF_WATERMARK_SIZE_RATIO
        ):
            watermark.append(char)
    text = "".join(char["text"] for char in watermark)
    signature = "".join(text.split()).casefold()
    if len(signature) >= PDF_REPEATED_TEXT_MINIMUM_CHARS:
        candidates.add(("watermark", signature))
    for line in page.extract_text_lines(return_chars=True):
        edge = (
            "header"
            if line["bottom"] <= page.height * PDF_MARGIN_RATIO
            else "footer" if line["top"] >= page.height * (1 - PDF_MARGIN_RATIO) else ""
        )
        signature = "".join(line["text"].split()).casefold()
        if edge and len(signature) >= PDF_REPEATED_TEXT_MINIMUM_CHARS:
            candidates.add((edge, signature))
    return candidates


def pdf_page_body_text(payload: bytes, page_number: int, original_text: str) -> str:
    """Exclude repeated marginal text and large diagonal watermarks from a page."""
    try:
        with pdfplumber.open(BytesIO(payload)) as document:
            if not 1 <= page_number <= len(document.pages):
                raise PdfDocumentError("pdf_page_invalid")
            page = document.pages[page_number - 1]
            candidates = _decoration_candidates(page)
            if not candidates:
                return original_text
            repeated = set()
            for neighbor in (page_number - 2, page_number):
                if 0 <= neighbor < len(document.pages):
                    repeated.update(_decoration_candidates(document.pages[neighbor]))
            positions = []
            normalized = []
            for position, character in enumerate(original_text):
                if not character.isspace():
                    folded = character.casefold()
                    normalized.extend(folded)
                    positions.extend([position] * len(folded))
            normalized_text = "".join(normalized)
            ranges = []
            for _, signature in candidates & repeated:
                start = normalized_text.find(signature)
                if start >= 0 and normalized_text.find(signature, start + 1) < 0:
                    ranges.append((positions[start], positions[start + len(signature) - 1] + 1))
            merged = []
            for start, end in sorted(ranges):
                if merged and start <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], end))
                else:
                    merged.append((start, end))
            for start, end in reversed(merged):
                original_text = original_text[:start] + original_text[end:]
            return original_text.strip()
    except PdfDocumentError:
        raise
    except Exception as error:
        raise PdfDocumentError("pdf_document_invalid") from error


def pdf_page_layout(payload: bytes, page_number: int) -> PdfPageLayout:
    if page_number < 1:
        raise PdfDocumentError("pdf_page_invalid")
    try:
        with pdfplumber.open(BytesIO(payload), laparams=PDF_LAYOUT_PARAMETERS) as document:
            if page_number > len(document.pages):
                raise PdfDocumentError("pdf_page_invalid")
            page = document.pages[page_number - 1]
            raw_words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
            words = tuple(
                PdfWord(
                    text=str(word.get("text") or ""),
                    bounds=_rect(word),
                    block=int(word.get("blockno", 0)),
                    line=int(word.get("line_no", index)),
                )
                for index, word in enumerate(raw_words)
                if word.get("text")
            )
            characters = tuple(
                PdfCharacter(str(character.get("text") or ""), _rect(character))
                for character in page.chars
                if character.get("text")
            )
            text_boxes = page.objects.get(PDF_TEXT_BOX_OBJECT, ())
            vertical_text_boxes = page.objects.get(PDF_VERTICAL_TEXT_BOX_OBJECT, ())
            fallback_lines = page.extract_text_lines(layout=False, return_chars=False)
            blocks = tuple(
                PdfTextBlock(str(line.get("text") or "").strip(), _rect(line), vertical)
                for items, vertical in (
                    (text_boxes or fallback_lines, False),
                    (vertical_text_boxes, True),
                )
                for line in items
                if str(line.get("text") or "").strip()
            )
            lines = tuple(
                PdfTextLine(str(line.get("text") or "").strip(), _rect(line), vertical)
                for key, vertical in (
                    (PDF_TEXT_LINE_OBJECT, False),
                    (PDF_VERTICAL_TEXT_LINE_OBJECT, True),
                )
                for line in page.objects.get(key, ())
                if str(line.get("text") or "").strip()
            )
            links = tuple(
                PdfLink(str(link.get("uri") or ""), _rect(link))
                for link in page.hyperlinks
                if link.get("uri")
            )
            return PdfPageLayout(
                page=page_number,
                width=float(page.width),
                height=float(page.height),
                rotation=int(page.rotation or 0),
                text=page.extract_text(layout=False) or "",
                words=words,
                characters=characters,
                blocks=blocks,
                lines=lines,
                links=links,
            )
    except PdfDocumentError:
        raise
    except Exception as error:
        raise PdfDocumentError("pdf_document_invalid") from error


def pdf_document_text(payload: bytes, page_numbers: Sequence[int] | None = None) -> tuple[str, ...]:
    _reader(payload)
    result = _native_pdf(payload, PdfNativeOperation.TEXT, page_numbers=page_numbers)
    if not isinstance(result, list) or not all(isinstance(page, str) for page in result):
        raise PdfDocumentError("pdf_worker_invalid_output")
    return tuple(result)


def pdf_image_bounds(
    payload: bytes, page_numbers: Sequence[int] | None = None
) -> tuple[tuple[PdfRect, ...], ...]:
    result = _native_pdf(payload, PdfNativeOperation.IMAGES, page_numbers=page_numbers)
    try:
        return tuple(tuple(PdfRect(*bounds) for bounds in page) for page in result)
    except (TypeError, ValueError) as error:
        raise PdfDocumentError("pdf_worker_invalid_output") from error


def render_pdf_page(
    payload: bytes,
    page_number: int,
    *,
    scale: float,
    crop: PdfRect | None = None,
) -> Image.Image:
    if page_number < 1 or scale <= 0:
        raise PdfDocumentError("pdf_render_invalid")
    try:
        result = _native_pdf(
            payload, PdfNativeOperation.RENDER, page_number=page_number, scale=scale
        )
        if not isinstance(result, str):
            raise PdfDocumentError("pdf_worker_invalid_output")
        with Image.open(BytesIO(base64.b64decode(result, validate=True))) as rendered:
            image = rendered.convert("RGB")
        if crop is not None:
            image = image.crop(
                (
                    round(crop.x0 * scale),
                    round(crop.top * scale),
                    round(crop.x1 * scale),
                    round(crop.bottom * scale),
                )
            )
        return image
    except PdfDocumentError:
        raise
    except Exception as error:
        raise PdfDocumentError("pdf_render_failed") from error


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
        reader, _encrypted = _reader(payload)
    except PdfDocumentError:
        return decode_records(EMPTY_RECORDS)
    try:
        matches = [
            attachment
            for attachment in reader.attachment_list
            if attachment.name == PDF_ANNOTATIONS_ATTACHMENT
        ]
        if not matches:
            return decode_records(EMPTY_RECORDS)
        if len(matches) != 1:
            raise PdfAnnotationError("duplicate PDF annotation attachments")
        attachment = matches[0]
        if attachment.size is not None and attachment.size > MAX_PDF_ANNOTATIONS_BYTES:
            raise PdfAnnotationError("PDF annotation attachment too large")
        attached = attachment.content
        if len(attached) > MAX_PDF_ANNOTATIONS_BYTES:
            raise PdfAnnotationError("PDF annotation attachment too large")
        records = decode_records(attached)
        if any(mark["page"] > len(reader.pages) for mark in records["marks"]):
            raise PdfAnnotationError("PDF annotation page out of range")
        return records
    except (PdfAnnotationError, RuntimeError, TypeError, ValueError, KeyError) as error:
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


def _quad_rect(quad: object, page: PdfPageLayout) -> PdfRect:
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
    return PdfRect(
        left * page.width,
        top * page.height,
        right * page.width,
        bottom * page.height,
    )


def _intersects(left: PdfRect, right: PdfRect) -> bool:
    return left.intersects(right)


def _same_vertical_band(top: float, bottom: float, other_top: float, other_bottom: float) -> bool:
    overlap = min(bottom, other_bottom) - max(top, other_top)
    minimum_height = min(bottom - top, other_bottom - other_top)
    return (
        overlap > 0
        and minimum_height > 0
        and overlap / minimum_height >= PDF_VISUAL_LINE_MINIMUM_OVERLAP_RATIO
    )


def _same_pdf_visual_line(word: PdfWord, top: float, bottom: float) -> bool:
    return _same_vertical_band(
        top,
        bottom,
        word.bounds.top,
        word.bounds.bottom,
    )


def _pdf_visual_lines(words: Sequence[PdfWord]) -> str:
    lines: list[str] = []
    current: list[str] = []
    line_top = 0.0
    line_bottom = 0.0
    for word in words:
        word_top = word.bounds.top
        word_bottom = word.bounds.bottom
        if current and not _same_pdf_visual_line(word, line_top, line_bottom):
            lines.append(" ".join(current))
            current = []
        if not current:
            line_top = word_top
            line_bottom = word_bottom
        else:
            line_top = min(line_top, word_top)
            line_bottom = max(line_bottom, word_bottom)
        current.append(word.text)
    if current:
        lines.append(" ".join(current))
    return "\n".join(lines)


def _pdf_character_selected(bounds: PdfRect, rects: Sequence[PdfRect]) -> bool:
    center = (bounds.x0 + bounds.x1) / 2
    return any(
        rect.x0 <= center <= rect.x1
        and _same_vertical_band(bounds.top, bounds.bottom, rect.top, rect.bottom)
        for rect in rects
    )


def _pdf_character_text(page: PdfPageLayout, rects: Sequence[PdfRect]) -> str:
    fragments: list[tuple[float, float, float, str]] = []
    character_rows: list[list[PdfCharacter]] = []
    for character in sorted(page.characters, key=lambda item: (item.bounds.top, item.bounds.x0)):
        if not _pdf_character_selected(character.bounds, rects):
            continue
        if character_rows and _same_vertical_band(
            character_rows[-1][0].bounds.top,
            character_rows[-1][0].bounds.bottom,
            character.bounds.top,
            character.bounds.bottom,
        ):
            character_rows[-1].append(character)
        else:
            character_rows.append([character])
    for row in character_rows:
        ordered = sorted(row, key=lambda item: item.bounds.x0)
        text = "".join(character.text for character in ordered).strip()
        if text:
            fragments.append(
                (
                    min(character.bounds.top for character in ordered),
                    max(character.bounds.bottom for character in ordered),
                    ordered[0].bounds.x0,
                    text,
                )
            )

    text_rows: list[str] = []
    current: list[tuple[float, str]] = []
    row_top = 0.0
    row_bottom = 0.0
    for top, bottom, text_left, text in fragments:
        if current and not _same_vertical_band(row_top, row_bottom, top, bottom):
            text_rows.append(" ".join(value for _, value in sorted(current)))
            current = []
        if not current:
            row_top = top
            row_bottom = bottom
        else:
            row_top = min(row_top, top)
            row_bottom = max(row_bottom, bottom)
        current.append((text_left, text))
    if current:
        text_rows.append(" ".join(value for _, value in sorted(current)))
    return "\n".join(text_rows)


def _pdf_candidates(words: Sequence[PdfWord]) -> tuple[str, ...]:
    word_text = [word.text for word in words]
    spaced = " ".join(word_text)
    compact = "".join(word_text)
    lines: list[str] = []
    current: list[str] = []
    prior_line: tuple[object, object] | None = None
    for word in words:
        line = (word.block, word.line)
        if prior_line is not None and line != prior_line:
            lines.append(" ".join(current))
            current = []
        current.append(word.text)
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
        page = pdf_page_layout(payload, page_number)
        rects = tuple(_quad_rect(quad, page) for quad in quads)
        if not rects:
            raise PdfSelectionError("pdf_quads")
        character_text = _pdf_character_text(page, rects)
        words = tuple(
            word for word in page.words if any(_intersects(word.bounds, rect) for rect in rects)
        )
    except PdfSelectionError:
        raise
    except (PdfDocumentError, RuntimeError, ValueError) as exc:
        raise PdfSelectionError("pdf_document") from exc
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
    "PdfCharacter",
    "PdfDocumentError",
    "PdfDocumentInfo",
    "PdfLink",
    "PdfMetadata",
    "PdfPageLayout",
    "PdfPasswordError",
    "PdfRect",
    "PdfTextBlock",
    "PdfTextLine",
    "PdfWord",
    "PdfAnnotationError",
    "embedded_pdf_records",
    "pdf_document_info",
    "pdf_document_text",
    "pdf_image_bounds",
    "pdf_metadata",
    "pdf_page_layout",
    "PdfSelectionError",
    "pdf_selection_matches",
    "pdf_selection_shape",
    "render_pdf_page",
    "resolve_pdf_selection",
]
