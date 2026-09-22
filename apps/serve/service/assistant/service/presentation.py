"""Readable projections for immutable PDF citation receipts."""

from __future__ import annotations

import re
import unicodedata
from enum import StrEnum

from service.platform.citations import PDF_FIGURE, PDF_TABLE

PRESENTATION_VERSION = 1
UNDECODED_TEXT = re.compile(r"\(cid:\d+\)|\ufffd")
MIXED_YI_TEXT = re.compile(r"[\ua000-\ua48f]")
ZERO_WIDTH_TEXT = re.compile(r"[\u200b\u200c\u200d\ufeff]")
CONTROL_TEXT = re.compile(r"[^\S\r\n\t]+")
MULTIPLE_BLANK_LINES = re.compile(r"\n{3,}")
EXCESSIVE_INLINE_SPACE = re.compile(r"[ \t]{3,}")
LATIN_LINE_HYPHEN = re.compile(r"(?<=[A-Za-z])[-\u00ad][ \t]*\n[ \t]*(?=[A-Za-z])")
SINGLE_GLYPH_LINE = re.compile(r"(?m)^\s*\S\s*$")
ORPHAN_PREFIX_LINE = re.compile(r"^\s*\S{1,2}\s*\n\s*\S")
ORPHAN_SUFFIX_LINE = re.compile(r"\n\s*\S{1,2}\s*$")
TABLE_HEADING = re.compile(r"^\s*(?:表|table)\s*[\d０-９]+", re.IGNORECASE)
MATH_SYMBOL = re.compile(r"[=+\-×÷∑∏√∞≈≠≤≥∫∂^_{}\\]")
CJK_CHARACTER = re.compile(
    r"[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"
)
CJK_PUNCTUATION = frozenset("，。；：！？、）】》」』％℃°")
OPENING_PUNCTUATION = frozenset("（【《「『")
QUALITY_RATIO_DENOMINATOR = 5
MINIMUM_QUALITY_SAMPLE = 12
MINIMUM_SINGLE_GLYPH_LINES = 3
MINIMUM_MIXED_SCRIPT_CONTEXT = 4
MINIMUM_LAYOUT_LINES = 5
MAXIMUM_SHORT_LAYOUT_LINE_CHARS = 8
SHORT_LAYOUT_RATIO_DENOMINATOR = 3
EXTRACTION_PUNCTUATION = str.maketrans({"ꎬ": "，", "ꎮ": "。", "ꎻ": "；"})


class PresentationMode(StrEnum):
    STRUCTURED_TEXT = "structured_text"
    REGION_IMAGE = "region_image"
    UNAVAILABLE = "unavailable"


class PresentationPrecision(StrEnum):
    REGION = "region"
    PAGE = "page"
    SOURCE = "source"


class QualityReason(StrEnum):
    COMPLEX_LAYOUT = "complex_layout"
    EXCESSIVE_SPACING = "excessive_spacing"
    FRAGMENTED_LINES = "fragmented_lines"
    FORMULA = "formula"
    MIXED_SCRIPT = "mixed_script"
    UNDECODED = "undecoded"
    PAGE_ONLY = "page_only"
    SOURCE_UNAVAILABLE = "source_unavailable"


def _is_cjk(value: str) -> bool:
    return bool(value and CJK_CHARACTER.fullmatch(value[-1]))


def _join_lines(left: str, right: str) -> str:
    if not left or not right:
        return left + right
    if (
        _is_cjk(left)
        or _is_cjk(right)
        or right[0] in CJK_PUNCTUATION
        or left[-1] in OPENING_PUNCTUATION
    ):
        return left + right
    return f"{left} {right}"


def readable_text(value: str) -> str:
    """Normalize display-only layout noise without changing the stored receipt."""
    value = unicodedata.normalize("NFKC", value.translate(EXTRACTION_PUNCTUATION))
    value = ZERO_WIDTH_TEXT.sub("", value.replace("\r\n", "\n").replace("\r", "\n"))
    value = LATIN_LINE_HYPHEN.sub("", value)
    paragraphs = []
    for paragraph in re.split(r"\n\s*\n", value):
        lines = [CONTROL_TEXT.sub(" ", line).strip() for line in paragraph.split("\n")]
        lines = [line for line in lines if line]
        if not lines:
            continue
        joined = lines[0]
        for line in lines[1:]:
            joined = _join_lines(joined, line)
        paragraphs.append(joined)
    return MULTIPLE_BLANK_LINES.sub("\n\n", "\n\n".join(paragraphs)).strip()


def _has_fragmented_lines(value: str) -> bool:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    short_lines = [line for line in lines if len(line) <= MAXIMUM_SHORT_LAYOUT_LINE_CHARS]
    return (
        len(SINGLE_GLYPH_LINE.findall(value)) >= MINIMUM_SINGLE_GLYPH_LINES
        or bool(ORPHAN_PREFIX_LINE.search(value))
        or bool(ORPHAN_SUFFIX_LINE.search(value))
        or (
            len(lines) >= MINIMUM_LAYOUT_LINES
            and len(short_lines) * SHORT_LAYOUT_RATIO_DENOMINATOR >= len(lines)
        )
    )


def quality_reasons(record: dict) -> tuple[str, ...]:
    value = record.get("quote", "")
    normalized = unicodedata.normalize("NFKC", value.translate(EXTRACTION_PUNCTUATION))
    reasons: list[str] = []
    if record.get("fragment_kind") in (PDF_FIGURE, PDF_TABLE):
        reasons.append(QualityReason.COMPLEX_LAYOUT)
    if TABLE_HEADING.search(normalized):
        reasons.append(QualityReason.COMPLEX_LAYOUT)
    if UNDECODED_TEXT.search(value):
        reasons.append(QualityReason.UNDECODED)
    if (
        MIXED_YI_TEXT.search(normalized)
        and len(MIXED_YI_TEXT.sub("", normalized).strip()) >= MINIMUM_MIXED_SCRIPT_CONTEXT
    ):
        reasons.append(QualityReason.MIXED_SCRIPT)
    if EXCESSIVE_INLINE_SPACE.search(value):
        reasons.append(QualityReason.EXCESSIVE_SPACING)
    if _has_fragmented_lines(normalized):
        reasons.append(QualityReason.FRAGMENTED_LINES)
    visible = [character for character in value if not character.isspace()]
    if len(visible) >= MINIMUM_QUALITY_SAMPLE and len(
        MATH_SYMBOL.findall(value)
    ) * QUALITY_RATIO_DENOMINATOR >= len(visible):
        reasons.append(QualityReason.FORMULA)
    return tuple(dict.fromkeys(str(reason) for reason in reasons))


def project(record: dict, state: str) -> dict:
    pages = record.get("pages") or []
    exact_region = bool(pages and any(page.get("quads") for page in pages))
    reasons = list(quality_reasons(record))
    text = readable_text(record.get("quote", ""))
    if state in ("unavailable", "changed"):
        if not text or QualityReason.UNDECODED in reasons:
            return {
                "version": PRESENTATION_VERSION,
                "mode": PresentationMode.UNAVAILABLE,
                "precision": PresentationPrecision.SOURCE,
                "text": "",
                "quality_reasons": [*reasons, QualityReason.SOURCE_UNAVAILABLE],
                "manual_check": True,
            }
        return {
            "version": PRESENTATION_VERSION,
            "mode": PresentationMode.STRUCTURED_TEXT,
            "precision": PresentationPrecision.SOURCE,
            "text": text,
            "quality_reasons": reasons,
            "manual_check": True,
        }
    if pages and (reasons or not exact_region):
        reliable_region = exact_region and QualityReason.FRAGMENTED_LINES not in reasons
        if not reliable_region:
            reasons.append(QualityReason.PAGE_ONLY)
        return {
            "version": PRESENTATION_VERSION,
            "mode": PresentationMode.REGION_IMAGE,
            "precision": (
                PresentationPrecision.REGION if reliable_region else PresentationPrecision.PAGE
            ),
            "page": pages[0]["page"],
            "text": "",
            "quality_reasons": list(dict.fromkeys(str(reason) for reason in reasons)),
            "manual_check": True,
        }
    if text:
        return {
            "version": PRESENTATION_VERSION,
            "mode": PresentationMode.STRUCTURED_TEXT,
            "precision": (
                PresentationPrecision.REGION if exact_region else PresentationPrecision.SOURCE
            ),
            "text": text,
            "quality_reasons": reasons,
            "manual_check": False,
        }
    return {
        "version": PRESENTATION_VERSION,
        "mode": PresentationMode.UNAVAILABLE,
        "precision": PresentationPrecision.SOURCE,
        "text": "",
        "quality_reasons": [QualityReason.SOURCE_UNAVAILABLE],
        "manual_check": True,
    }


def display_pages(pages: list[dict], precision: str) -> list[dict]:
    """Return only coordinates whose precision is safe to present as exact."""
    if precision == PresentationPrecision.REGION:
        return pages
    return [{"page": page["page"], "quads": []} for page in pages]
