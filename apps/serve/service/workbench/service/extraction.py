"""Local PDF layout extraction; every displayed character retains its page geometry."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import asdict, replace
from io import BytesIO
from itertools import groupby
from statistics import median

import pdfplumber
from pdfplumber.page import Page

from service.platform.citations import (
    PDF_CAPTION,
    CitationPage,
    PdfFragment,
    PdfIndex,
    PdfOmission,
    PdfSpan,
)
from service.platform.pdf import pdf_image_bounds
from service.workbench.service.fonts import GlyphResourceManager
from service.workbench.service.layout import classify
from service.workbench.service.sentences import TRUNCATED, SentenceBlock, assemble, sentence_ends

EXTRACTOR_VERSION = f"pdfplumber-{pdfplumber.__version__}/pdfium-images/captions-spans-v11"
MAX_DOCUMENT_FRAGMENTS = 100_000
QUARTER_TURN = 90
FULL_TURN = 360
LAYOUT_WORD_MARGIN = 0.1
LAYOUT_PARAMETERS = {"boxes_flow": 0.5, "word_margin": LAYOUT_WORD_MARGIN, "all_texts": True}
MAX_DOCUMENT_BYTES = 100_000_000
MAX_DOCUMENT_PAGES = 2_000
MAX_DOCUMENT_CHARACTERS = 4_000_000
MAX_FRAGMENT_CHARACTERS = 1_200
COORDINATE_PRECISION = 7
TEXT_BOX_KIND = "textboxhorizontal"
TEXT_LINE_KIND = "textlinehorizontal"
REVISION_PREFIX = "sha256:"
START_PAGE_OPTION = "--start-page"
END_PAGE_OPTION = "--end-page"
UNDECODED_CHARACTER = re.compile(r"\(cid:\d+\)|\ufffd")
POSITIONED_WORD = re.compile(r"\S+")
CJK_CHARACTER = re.compile(
    r"[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"
)
CJK_CLOSING_PUNCTUATION = frozenset("，。；：！？、）】》」』％℃°")
CJK_OPENING_PUNCTUATION = frozenset("（【《「『")


def index_identity(revision: str) -> str:
    return hashlib.sha256(f"{EXTRACTOR_VERSION}:{revision}".encode()).hexdigest()


def _is_cjk(value: str) -> bool:
    return bool(value and CJK_CHARACTER.fullmatch(value))


def _needs_layout_space(previous: dict | None, current: dict) -> bool:
    if previous is None:
        return False
    left = previous["text"][-1:]
    right = current["text"][:1]
    if not left or not right or left.isspace() or right.isspace():
        return False
    if (
        (_is_cjk(left) and _is_cjk(right))
        or right in CJK_CLOSING_PUNCTUATION
        or left in CJK_OPENING_PUNCTUATION
    ):
        return False
    gap = current["x0"] - previous["x1"]
    glyph = max(
        current["x1"] - current["x0"],
        current["bottom"] - current["top"],
        previous["x1"] - previous["x0"],
        previous["bottom"] - previous["top"],
    )
    return gap > glyph * LAYOUT_WORD_MARGIN


def _passages(
    lines: list[list[dict]], page_number: int, bounds: tuple[float, ...], *, caption: bool = False
) -> list[PdfFragment]:
    """Split within a layout box, never stitch parallel columns into a sentence."""
    text = ""
    mapping: list[tuple[int, dict] | None] = []
    for line_number, line in enumerate(lines):
        previous: dict | None = None
        for char in sorted(line, key=lambda item: item["x0"]):
            if _needs_layout_space(previous, char):
                text += " "
                mapping.append(None)
            previous = char
            value = char["text"]
            text += value
            mapping.extend((line_number, char) for _ in value)
        text += "\n"
        mapping.append(None)
    fragments: list[PdfFragment] = []
    start = 0
    # Paragraph locations are authoritative; punctuation splitting is bounded inside
    # the same layout box and never claims cross-page semantic continuity.
    ends = [len(text)] if caption else sentence_ends(text) + [len(text)]
    for end in ends:
        truncated = end - start > MAX_FRAGMENT_CHARACTERS
        group_start = len(fragments)
        while end - start > MAX_FRAGMENT_CHARACTERS:
            split = text.rfind("\n", start + 1, start + MAX_FRAGMENT_CHARACTERS)
            if split <= start:
                split = start + MAX_FRAGMENT_CHARACTERS
            fragments.extend(_fragment(text, mapping, start, split, bounds, page_number))
            start = split
        fragments.extend(_fragment(text, mapping, start, end, bounds, page_number))
        start = end
        if truncated:
            fragments[group_start:] = [
                replace(item, kind=TRUNCATED) for item in fragments[group_start:]
            ]
    return [replace(item, kind=PDF_CAPTION) for item in fragments] if caption else fragments


def _page_geometry(bounds: tuple, viewport: tuple, page: int, rotation: int = 0) -> CitationPage:
    left, top, right, bottom = viewport
    x0, y0, x1, y1 = bounds
    x0, x1 = (x0 - left) / (right - left), (x1 - left) / (right - left)
    y0, y1 = (y0 - top) / (bottom - top), (y1 - top) / (bottom - top)
    for _ in range((rotation % FULL_TURN) // QUARTER_TURN):
        x0, y0, x1, y1 = 1 - y1, x0, 1 - y0, x1
    return CitationPage(
        page,
        (
            tuple(
                round(max(0.0, min(1.0, value)), COORDINATE_PRECISION) for value in (x0, y0, x1, y1)
            ),
        ),
    )


def _fragment(
    text: str, mapping: list, start: int, end: int, bounds: tuple, page: int
) -> list[PdfFragment]:
    value = text[start:end].strip()
    if not value:
        return []
    lines: dict[int, list[dict]] = {}
    for anchor in mapping[start:end]:
        if anchor is not None and anchor[1]["text"].strip():
            lines.setdefault(anchor[0], []).append(anchor[1])
    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    quads = tuple(
        tuple(
            round(value, COORDINATE_PRECISION)
            for value in (
                max(0.0, (min(char["x0"] for char in chars) - left) / width),
                max(0.0, (min(char["top"] for char in chars) - top) / height),
                min(1.0, (max(char["x1"] for char in chars) - left) / width),
                min(1.0, (max(char["bottom"] for char in chars) - top) / height),
            )
        )
        for chars in lines.values()
    )
    offset = start + len(text[start:end]) - len(text[start:end].lstrip())
    spans = []
    for word in POSITIONED_WORD.finditer(value):
        positioned: dict[int, list[dict]] = {}
        for anchor in mapping[offset + word.start() : offset + word.end()]:
            if anchor is not None:
                positioned.setdefault(anchor[0], []).append(anchor[1])
        for chars in positioned.values():
            quad = tuple(
                round(coordinate, COORDINATE_PRECISION)
                for coordinate in (
                    max(0.0, (min(char["x0"] for char in chars) - left) / width),
                    max(0.0, (min(char["top"] for char in chars) - top) / height),
                    min(1.0, (max(char["x1"] for char in chars) - left) / width),
                    min(1.0, (max(char["bottom"] for char in chars) - top) / height),
                )
            )
            spans.append(PdfSpan(word.start(), word.end(), page, quad))
    return (
        [PdfFragment("", value, (CitationPage(page, quads),), spans=tuple(spans))] if quads else []
    )


def extract(payload: bytes, start_page: int = 0, end_page: int = 0) -> PdfIndex:
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise ValueError("pdf_too_large")
    if bool(start_page) != bool(end_page) or start_page < 0 or end_page < start_page:
        raise ValueError("pdf_page_range_invalid")
    revision = REVISION_PREFIX + hashlib.sha256(payload).hexdigest()
    fragments: list[PdfFragment] = []
    blocks: list[SentenceBlock] = []
    unavailable: list[int] = []
    omissions: list[PdfOmission] = []
    native_regions: list[CitationPage] = []
    characters = 0
    image_pages = pdf_image_bounds(payload)
    with pdfplumber.open(BytesIO(payload), laparams=LAYOUT_PARAMETERS) as pdf:
        pdf.rsrcmgr = GlyphResourceManager()
        if len(pdf.pages) > MAX_DOCUMENT_PAGES:
            raise ValueError("pdf_too_many_pages")
        page_count = len(pdf.pages)
        first_page = start_page or 1
        last_page = end_page or page_count
        if first_page < 1 or last_page > page_count:
            raise ValueError("pdf_page_range_invalid")
        for original in pdf.pages[first_page - 1 : last_page]:
            rotation = original.rotation
            # Read in native page orientation; rotate normalized CropBox coordinates
            # afterwards to match PDF.js's default display viewport.
            original.page_obj.attrs["Rotate"] = 0
            original.page_obj.rotate = 0
            page = Page(pdf, original.page_obj, original.page_number)
            bounds = tuple(page.cropbox or page.bbox)
            all_chars = page.dedupe_chars().chars
            chars = [
                char
                for char in all_chars
                if char.get("upright", True)
                and bounds[0] <= (char["x0"] + char["x1"]) / 2 <= bounds[2]
                and bounds[1] <= (char["top"] + char["bottom"]) / 2 <= bounds[3]
            ]
            characters += len(chars)
            if characters > MAX_DOCUMENT_CHARACTERS:
                raise ValueError("pdf_too_large")
            images = tuple(
                (
                    image.x0 + bounds[0],
                    image.top + bounds[1],
                    image.x1 + bounds[0],
                    image.bottom + bounds[1],
                )
                for image in image_pages[page.page_number - 1]
            )
            layout = classify(page, chars, images=images)
            excluded = {ordinal for ordinal, char in enumerate(chars) if layout.omitted(char)}
            for region in layout.regions:
                native_regions.append(_page_geometry(region.bounds, bounds, page.page_number))
                omissions.append(
                    PdfOmission(
                        region.kind,
                        region.reason,
                        (_page_geometry(region.bounds, bounds, page.page_number, rotation),),
                    )
                )
            # pdfminer layout boxes preserve column boundaries. Unassigned characters
            # are not folded into an arbitrary full-page paragraph.
            assigned: set[int] = set()
            before = len(fragments)
            block_start = len(blocks)
            for box in page.objects.get(TEXT_BOX_KIND, ()):
                # Preserve pdfminer's line membership: superscripts/subscripts have
                # different tops but still belong to the surrounding sentence.
                runs: list[tuple[bool, bool, list[list[dict]]]] = []
                interrupted = False
                for line in sorted(
                    page.objects.get(TEXT_LINE_KIND, ()), key=lambda item: (item["top"], item["x0"])
                ):
                    if not (
                        box["x0"] <= (line["x0"] + line["x1"]) / 2 <= box["x1"]
                        and box["top"] <= (line["top"] + line["bottom"]) / 2 <= box["bottom"]
                    ):
                        continue
                    selected = []
                    for ordinal, char in enumerate(chars):
                        x = (char["x0"] + char["x1"]) / 2
                        y = (char["top"] + char["bottom"]) / 2
                        if (
                            ordinal not in assigned
                            and line["x0"] <= x <= line["x1"]
                            and line["top"] <= y <= line["bottom"]
                        ):
                            assigned.add(ordinal)
                            selected.append((ordinal in excluded, layout.caption(char), char))
                    # Keep each retained run separate when a visual line crosses an
                    # excluded region, including a caption/body role change.
                    for (removed, caption), group in groupby(
                        sorted(selected, key=lambda item: item[2]["x0"]),
                        key=lambda item: item[:2],
                    ):
                        letters = [item[2] for item in group]
                        if removed:
                            interrupted = True
                            continue
                        if not runs or runs[-1][0] != caption or interrupted:
                            runs.append((caption, interrupted, []))
                        runs[-1][2].append(letters)
                        interrupted = False
                for caption, break_before, lines in runs:
                    passages = _passages(lines, page.page_number, bounds, caption=caption)
                    if not passages:
                        continue
                    letters = [char for line in lines for char in line if char["text"].strip()]
                    font = Counter(char["fontname"] for char in letters).most_common(1)[0][0]
                    x0, y0, x1, y1 = bounds
                    blocks.append(
                        SentenceBlock(
                            tuple(passages),
                            page.page_number,
                            (
                                (min(char["x0"] for char in letters) - x0) / (x1 - x0),
                                (min(char["top"] for char in letters) - y0) / (y1 - y0),
                                (max(char["x1"] for char in letters) - x0) / (x1 - x0),
                                (max(char["bottom"] for char in letters) - y0) / (y1 - y0),
                            ),
                            font,
                            median(char["size"] for char in letters),
                            median(char["bottom"] - char["top"] for char in letters) / (y1 - y0),
                            len(lines),
                            rotation,
                            break_before,
                        )
                    )
                    fragments.extend(passages)
            if len(fragments) > MAX_DOCUMENT_FRAGMENTS:
                raise ValueError("pdf_too_many_fragments")
            if rotation:
                for ordinal in range(before, len(fragments)):
                    fragment = fragments[ordinal]
                    quads = []
                    for quad in fragment.pages[0].quads:
                        quads.append(rotate_quad(quad, rotation))
                    fragments[ordinal] = replace(
                        fragment,
                        pages=(CitationPage(page.page_number, tuple(quads)),),
                        spans=tuple(
                            replace(span, quad=rotate_quad(span.quad, rotation))
                            for span in fragment.spans
                        ),
                    )
            cursor = before
            for ordinal in range(block_start, len(blocks)):
                count = len(blocks[ordinal].fragments)
                blocks[ordinal] = replace(
                    blocks[ordinal], fragments=tuple(fragments[cursor : cursor + count])
                )
                cursor += count
            if (
                (len(fragments) == before and not layout.regions)
                or len(assigned | excluded) < len(chars)
                or any(
                    not char.get("upright", True) and not layout.omitted(char) for char in all_chars
                )
                or any(
                    ordinal not in excluded and UNDECODED_CHARACTER.search(char["text"])
                    for ordinal, char in enumerate(chars)
                )
            ):
                unavailable.append(page.page_number)
            page.close()
    identity = index_identity(revision)
    assembled = (
        [
            fragment
            for page_number in range(first_page, last_page + 1)
            for fragment in assemble(
                [block for block in blocks if block.page == page_number],
                (page_number,) if page_number in unavailable else (),
                tuple(region for region in native_regions if region.page == page_number),
            )
        ]
        if start_page
        else assemble(blocks, tuple(unavailable), tuple(native_regions))
    )
    indexed = tuple(
        replace(
            item,
            fragment_id="s_"
            + hashlib.sha256(
                (identity + json.dumps(asdict(item), sort_keys=True, ensure_ascii=False)).encode()
            ).hexdigest(),
        )
        for item in assembled
    )
    return PdfIndex(identity, revision, indexed, page_count, tuple(unavailable), tuple(omissions))


def decode_index(payload: dict) -> PdfIndex:
    return PdfIndex(
        payload["index_id"],
        payload["revision"],
        tuple(
            PdfFragment(
                item["fragment_id"],
                item["text"],
                tuple(
                    CitationPage(page["page"], tuple(tuple(quad) for quad in page["quads"]))
                    for page in item["pages"]
                ),
                item["kind"],
                tuple(
                    PdfSpan(span["start"], span["end"], span["page"], tuple(span["quad"]))
                    for span in item["spans"]
                ),
                item["continuity"],
            )
            for item in payload["fragments"]
        ),
        payload["page_count"],
        tuple(payload["unavailable_pages"]),
        tuple(
            PdfOmission(
                item["kind"],
                item["reason"],
                tuple(
                    CitationPage(page["page"], tuple(tuple(quad) for quad in page["quads"]))
                    for page in item["pages"]
                ),
            )
            for item in payload["omissions"]
        ),
    )


def rotate_quad(quad: tuple, rotation: int) -> tuple:
    x0, y0, x1, y1 = quad
    for _ in range((rotation % FULL_TURN) // QUARTER_TURN):
        x0, y0, x1, y1 = 1 - y1, x0, 1 - y0, x1
    return x0, y0, x1, y1


def main() -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument(START_PAGE_OPTION, type=int, default=0)
        parser.add_argument(END_PAGE_OPTION, type=int, default=0)
        arguments = parser.parse_args()
        result = extract(
            sys.stdin.buffer.read(MAX_DOCUMENT_BYTES + 1),
            start_page=arguments.start_page,
            end_page=arguments.end_page,
        )
        print(json.dumps({"ok": True, "index": asdict(result)}, ensure_ascii=False))
        return 0
    except Exception as error:
        # Process boundary: malformed parser input must not terminate Serve. Preserve
        # an explicit failed result; no partial index is published as success.
        print(json.dumps({"ok": False, "error": f"pdf_parse_failed:{type(error).__name__}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
