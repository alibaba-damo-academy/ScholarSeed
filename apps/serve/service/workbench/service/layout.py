"""Geometric PDF content eligibility before sentence extraction.

Detectors describe regions, never interpret chart values or rewrite captions.
Large background images are not evidence for discarding an existing OCR layer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import median

from pdfplumber.page import Page

from service.platform.citations import (
    PDF_FIGURE,
    PDF_FORMULA,
    PDF_TABLE,
    PDF_TEXT_EXCLUDE,
    PDF_TEXT_RETAIN,
)

Bounds = tuple[float, float, float, float]
TEXT_BOX = "textboxhorizontal"
TEXT_LINE = "textlinehorizontal"
IMAGE = "image"
BACKGROUND_AREA_RATIO = 0.85
MIN_REGION_WIDTH_RATIO = 0.08
MIN_REGION_HEIGHT = 12.0
GRAPHIC_JOIN_GAP = 8.0
CAPTION_GAP = 48.0
CAPTION_LINE_GAP_RATIO = 1.5
CAPTION_FONT_TOLERANCE = 0.15
REGION_PADDING = 2.0
MIN_TABLE_ROWS = 3
MIN_TABLE_RULES = 2
MIN_TABLE_COLUMNS = 2
MIN_TABLE_NUMERIC_CELLS = 1
TABLE_SEARCH_HEIGHT_RATIO = 0.4
WORD_GAP_RATIO = 0.1
TABLE_CELL_GAP = 8.0
TABLE_LINE_TOLERANCE = 3.0
TABLE_ROW_GAP = 25.0
MAX_CELL_WORDS = 5
MIN_NUMERIC_ROW_RATIO = 0.5
COLUMN_ALIGNMENT_TOLERANCE = 10.0
RULE_ALIGNMENT_TOLERANCE = 3.0
MAX_RULE_GAP_RATIO = 0.2
MIN_COLUMN_WIDTH_RATIO = 0.2
MAX_LABEL_WORDS = 5
MAX_LABEL_CHARACTERS = 80
LABEL_GAP = 36.0
PROSE_LINE_WORDS = 6
UPPER_REGION_RATIO = 0.5
FORMULA_MIN_OPERATORS = 2
FORMULA_MAX_WORDS = 14
FORMULA_MIN_WIDTH_RATIO = 0.12
FORMULA_MAX_WIDTH_RATIO = 0.9
FORMULA_LINE_GAP_RATIO = 1.5
FORMULA_ANCHOR_BAND_RATIO = 2.4
FORMULA_PROSE_WORDS = 4
FORMULA_SYMBOL_RATIO = 0.12
FORMULA_PROSE_SYMBOL_RATIO = 0.18
FORMULA_INDENT_RATIO = 0.02
FORMULA_COLUMN_MIN_WIDTH_RATIO = 0.15
FORMULA_COLUMN_MIN_LINES = 2
FIGURE_BODY_MIN_CHARACTERS = 30
FIGURE_BODY_MIN_WIDTH_RATIO = 0.55
FIGURE_BODY_ALIGNMENT_TOLERANCE = 10.0
FIGURE_PAGE_MARGIN_RATIO = 0.04
FIGURE_INFERENCE_MIN_LABELS = 2
FIGURE_CAPTION_SIDE_RATIO = 0.5
FIGURE_WIDE_CAPTION_RATIO = 0.6
CAPTION_LABELS = {
    PDF_FIGURE: r"(?:fig(?:ure)?s?\.?|图)",
    PDF_TABLE: r"(?:tables?|表)",
}
CAPTION_PATTERNS = tuple(
    (
        kind,
        re.compile(
            rf"^\s*{label}\s*(?:[A-Z]?\d+(?:[.\-]\d+)*|[IVX]+)"
            r"(?P<separator>\s*[|.:：、)）\-]|\s+|$)",
            re.IGNORECASE,
        ),
    )
    for kind, label in CAPTION_LABELS.items()
)
CAPTION_PUNCTUATION = frozenset("|.:：、)）")
IMAGE_REASON = "image_region"
VECTOR_REASON = "graphic_region"
CAPTION_FIGURE_REASON = "caption_figure_region"
TABLE_REASON = "table_region"
SUSPECTED_TABLE_REASON = "caption_table_region"
NUMERIC_CELL = re.compile(r"\d")
FORMULA_OPERATOR = re.compile(r"[=+\-*/^_|<>≤≥≈≠∑∏∫√∞∂∇]")
FORMULA_RELATION = re.compile(r"[=<>≤≥≈≠∈∼∝→⇒⇔]")
FORMULA_LARGE_OPERATOR = re.compile(r"[∑∏∫√]")
FORMULA_PROSE_WORD = re.compile(r"[A-Za-z]{3,}")
FORMULA_STRUCTURE = re.compile(r"[()[\]{}]|(?:\\|_\{|\^\{|\b(?:sin|cos|log|exp|lim|max|min)\b)")
FORMULA_NUMBER = re.compile(r"\(\s*(?P<number>\d{1,3})(?:[.\-]\d+)*\s*\)\s*$")
FORMULA_NUMBER_ONLY = re.compile(r"^\s*\(\s*(?P<number>\d{1,3})\s*\)\s*$")


@dataclass(frozen=True)
class Region:
    bounds: Bounds
    kind: str
    reason: str
    text_policy: str = PDF_TEXT_EXCLUDE
    interactive: bool = True


@dataclass(frozen=True)
class Layout:
    regions: tuple[Region, ...]
    captions: tuple[Bounds, ...]

    def caption(self, char: dict) -> bool:
        return any(contains(bounds, char) for bounds in self.captions)

    def omitted(self, char: dict) -> bool:
        return not self.caption(char) and any(
            region.text_policy == PDF_TEXT_EXCLUDE and contains(region.bounds, char)
            for region in self.regions
        )


@dataclass(frozen=True)
class FormulaCandidate:
    bounds: Bounds
    size: float
    number: int | None
    column: tuple[float, float]


def bounds_of(item: dict) -> Bounds:
    return item["x0"], item["top"], item["x1"], item["bottom"]


def contains(bounds: Bounds, char: dict) -> bool:
    x = (char["x0"] + char["x1"]) / 2
    y = (char["top"] + char["bottom"]) / 2
    return bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3]


def union(left: Bounds, right: Bounds) -> Bounds:
    return (
        min(left[0], right[0]),
        min(left[1], right[1]),
        max(left[2], right[2]),
        max(left[3], right[3]),
    )


def nearby(left: Bounds, right: Bounds, gap: float) -> bool:
    return (
        left[0] <= right[2] + gap
        and right[0] <= left[2] + gap
        and left[1] <= right[3] + gap
        and right[1] <= left[3] + gap
    )


def _substantial(bounds: Bounds, page: Page) -> bool:
    return (
        bounds[2] - bounds[0] >= page.width * MIN_REGION_WIDTH_RATIO
        and bounds[3] - bounds[1] >= MIN_REGION_HEIGHT
        and (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])
        < page.width * page.height * BACKGROUND_AREA_RATIO
    )


def _images(page: Page, images: tuple[Bounds, ...]) -> list[Region]:
    candidates = [*images, *(bounds_of(image) for image in page.images)]
    retained: list[Bounds] = []
    for bounds in candidates:
        if _substantial(bounds, page) and bounds not in retained:
            retained.append(bounds)
    return [Region(bounds, PDF_FIGURE, IMAGE_REASON) for bounds in retained]


def _graphics(page: Page) -> list[Region]:
    # Connected strokes cover vector plots/diagrams as well as raster-free figures.
    # Thin isolated rules and full-page borders do not qualify as figure regions.
    groups: list[Bounds] = []
    for item in (*page.lines, *page.rects, *page.curves):
        candidate = bounds_of(item)
        if (candidate[2] - candidate[0]) * (
            candidate[3] - candidate[1]
        ) >= page.width * page.height * BACKGROUND_AREA_RATIO:
            continue
        remaining = []
        for group in groups:
            if nearby(group, candidate, GRAPHIC_JOIN_GAP):
                candidate = union(group, candidate)
            else:
                remaining.append(group)
        # A newly joined component may now meet an earlier component.
        changed = True
        while changed:
            changed = False
            for group in tuple(remaining):
                if nearby(group, candidate, GRAPHIC_JOIN_GAP):
                    candidate = union(group, candidate)
                    remaining.remove(group)
                    changed = True
        groups = [*remaining, candidate]
    return [
        Region(group, PDF_FIGURE, VECTOR_REASON) for group in groups if _substantial(group, page)
    ]


def _tables(page: Page) -> list[Region]:
    regions: list[Region] = []
    for table in page.find_tables():
        if len(table.rows) < MIN_TABLE_ROWS or len(table.columns) < MIN_TABLE_COLUMNS:
            continue
        left, top, right, bottom = table.bbox
        regions.append(
            Region(
                (float(left), float(top), float(right), float(bottom)),
                PDF_TABLE,
                TABLE_REASON,
            )
        )
    return regions


REGION_DETECTORS = (_graphics, _tables)


def _formulas(page: Page, chars: list[dict], blocked: list[Region]) -> list[Region]:
    lines = sorted(page.objects.get(TEXT_LINE, ()), key=lambda item: (item["top"], item["x0"]))
    candidates: list[FormulaCandidate] = []
    consumed: set[int] = set()
    anchors = [
        (line_index, line, anchor_match, _formula_column_limits(page, bounds_of(line)))
        for line_index, line in enumerate(lines)
        if (
            anchor_match := FORMULA_NUMBER_ONLY.fullmatch(
                _line_text(_line_chars(line, chars)).strip()
            )
        )
        is not None
    ]
    for anchor_position, (anchor_index, anchor, anchor_match, column) in enumerate(anchors):
        anchor_letters = _line_chars(anchor, chars)
        if not anchor_letters:
            continue
        size = median(char["size"] for char in anchor_letters)
        band_top = anchor["top"] - size * FORMULA_ANCHOR_BAND_RATIO
        band_bottom = anchor["bottom"] + size * FORMULA_ANCHOR_BAND_RATIO
        anchor_center = (anchor["top"] + anchor["bottom"]) / 2
        previous_anchors = [
            previous for previous in anchors[:anchor_position] if previous[3] == column
        ]
        next_anchors = [
            following for following in anchors[anchor_position + 1 :] if following[3] == column
        ]
        if previous_anchors:
            previous = previous_anchors[-1][1]
            previous_center = (previous["top"] + previous["bottom"]) / 2
            band_top = max(band_top, (previous_center + anchor_center) / 2)
        if next_anchors:
            following = next_anchors[0][1]
            following_center = (following["top"] + following["bottom"]) / 2
            band_bottom = min(band_bottom, (anchor_center + following_center) / 2)
        body: Bounds | None = None
        body_indexes = []
        for line_index, line in enumerate(lines):
            line_center = (line["top"] + line["bottom"]) / 2
            if line_index == anchor_index or not band_top <= line_center <= band_bottom:
                continue
            letters = _line_chars(line, chars)
            text = _line_text(letters).strip()
            if not text or len(text.split()) > FORMULA_MAX_WORDS:
                continue
            prose_words = len(FORMULA_PROSE_WORD.findall(text))
            if (
                prose_words >= FORMULA_PROSE_WORDS
                and FORMULA_RELATION.search(text) is None
                and FORMULA_LARGE_OPERATOR.search(text) is None
            ):
                continue
            line_bounds = bounds_of(line)
            if (
                line_bounds[0] < column[0]
                or line_bounds[2] > column[1]
                or line_bounds[2] - line_bounds[0] > page.width * FORMULA_MAX_WIDTH_RATIO
                or line_bounds[0] <= page.bbox[0] + page.width * FORMULA_INDENT_RATIO
            ):
                continue
            body = line_bounds if body is None else union(body, line_bounds)
            body_indexes.append(line_index)
        if body is None or any(nearby(body, region.bounds, 0) for region in blocked):
            continue
        candidates.append(
            FormulaCandidate(
                union(body, bounds_of(anchor)),
                size,
                int(anchor_match["number"]),
                column,
            )
        )
        consumed.update(body_indexes)
        consumed.add(anchor_index)
    for line_index, line in enumerate(lines):
        if line_index in consumed:
            continue
        letters = _line_chars(line, chars)
        if not letters:
            continue
        text = _line_text(letters).strip()
        width = line["x1"] - line["x0"]
        operators = len(FORMULA_OPERATOR.findall(text))
        structures = len(FORMULA_STRUCTURE.findall(text))
        words = text.split()
        equation_match = FORMULA_NUMBER.search(text)
        equation_numbered = equation_match is not None
        compact = "".join(text.split())
        symbol_ratio = operators / max(1, len(compact))
        prose_words = len(FORMULA_PROSE_WORD.findall(text))
        relation = bool(FORMULA_RELATION.search(text))
        large_operator = bool(FORMULA_LARGE_OPERATOR.search(text))
        indented = line["x0"] >= page.bbox[0] + page.width * FORMULA_INDENT_RATIO
        formula_like = (
            equation_numbered
            or large_operator
            or (
                operators >= FORMULA_MIN_OPERATORS
                and relation
                and (structures > 0 or symbol_ratio >= FORMULA_SYMBOL_RATIO)
            )
        )
        line_bounds = bounds_of(line)
        column = _formula_column_limits(page, line_bounds)
        if (
            formula_like
            and (
                equation_numbered
                or prose_words < FORMULA_PROSE_WORDS
                or symbol_ratio >= FORMULA_PROSE_SYMBOL_RATIO
            )
            and (equation_numbered or indented)
            and len(words) <= FORMULA_MAX_WORDS
            and page.width * FORMULA_MIN_WIDTH_RATIO
            <= width
            <= page.width * FORMULA_MAX_WIDTH_RATIO
            and not any(nearby(line_bounds, region.bounds, 0) for region in blocked)
        ):
            candidates.append(
                FormulaCandidate(
                    line_bounds,
                    median(char["size"] for char in letters),
                    int(equation_match["number"]) if equation_match else None,
                    column,
                )
            )
    regions: list[Region] = []
    previous_candidate = None
    for candidate in candidates:
        close = bool(
            regions
            and previous_candidate is not None
            and candidate.column == previous_candidate.column
            and (
                previous_candidate.number is None
                or candidate.number is None
                or candidate.number == previous_candidate.number
            )
            and nearby(
                regions[-1].bounds,
                candidate.bounds,
                candidate.size * FORMULA_LINE_GAP_RATIO,
            )
        )
        if regions and close:
            previous_region = regions[-1]
            combined = union(previous_region.bounds, candidate.bounds)
            regions[-1] = Region(combined, PDF_FORMULA, "formula_lines", PDF_TEXT_RETAIN)
        else:
            regions.append(Region(candidate.bounds, PDF_FORMULA, "formula_line", PDF_TEXT_RETAIN))
        previous_candidate = candidate
    return regions


def _formula_column_limits(page: Page, anchor: Bounds) -> tuple[float, float]:
    midpoint = page.bbox[0] + page.width / 2
    wide_boxes = [
        bounds_of(box)
        for box in page.objects.get(TEXT_BOX, ())
        if box["x1"] - box["x0"] >= page.width * FORMULA_COLUMN_MIN_WIDTH_RATIO
    ]
    left_boxes = [bounds for bounds in wide_boxes if bounds[2] < midpoint]
    right_boxes = [bounds for bounds in wide_boxes if bounds[0] > midpoint]
    if len(left_boxes) < FORMULA_COLUMN_MIN_LINES or len(right_boxes) < FORMULA_COLUMN_MIN_LINES:
        return page.bbox[0], page.bbox[2]
    gutter_left = max(bounds[2] for bounds in left_boxes)
    gutter_right = min(bounds[0] for bounds in right_boxes)
    if gutter_left >= gutter_right:
        return page.bbox[0], page.bbox[2]
    gutter = (gutter_left + gutter_right) / 2
    if (anchor[0] + anchor[2]) / 2 < gutter:
        return page.bbox[0], gutter
    return gutter, page.bbox[2]


def _horizontal_overlap(left: Bounds, right: Bounds) -> float:
    return max(0.0, min(left[2], right[2]) - max(left[0], right[0]))


def _line_chars(line: dict, chars: list[dict]) -> list[dict]:
    return sorted(
        (char for char in chars if contains(bounds_of(line), char)), key=lambda char: char["x0"]
    )


def _line_text(chars: list[dict]) -> str:
    text = ""
    previous = None
    for char in chars:
        if previous and char["x0"] - previous["x1"] > char["size"] * WORD_GAP_RATIO:
            text += " "
        text += char["text"]
        previous = char
    return text


def _captions(page: Page, chars: list[dict], regions: list[Region]) -> list[tuple[Bounds, str]]:
    captions = []
    for box in page.objects.get(TEXT_BOX, ()):
        active = None
        previous = None
        font_size = 0.0
        start_bounds = None
        lines = sorted(
            (line for line in page.objects.get(TEXT_LINE, ()) if contains(bounds_of(box), line)),
            key=lambda line: (line["top"], line["x0"]),
        )
        for line_number, line in enumerate(lines):
            letters = _line_chars(line, chars)
            if not letters:
                continue
            text = _line_text(letters)
            matched = next(
                (
                    (kind, match)
                    for kind, pattern in CAPTION_PATTERNS
                    if (match := pattern.match(text))
                ),
                None,
            )
            if matched:
                kind, match = matched
                separator = match["separator"].strip()
                related = any(
                    nearby(bounds_of(line), region.bounds, CAPTION_GAP)
                    for region in regions
                    if region.kind == kind
                )
                starts_block = line_number == 0 or all(
                    any(contains(region.bounds, earlier) for region in regions)
                    for earlier in lines[:line_number]
                )
                if starts_block and (related or separator in CAPTION_PUNCTUATION):
                    captions.append((bounds_of(line), kind))
                    active = len(captions) - 1
                    font_size = median(char["size"] for char in letters)
                    previous = line
                    start_bounds = bounds_of(line)
                    continue
            size = median(char["size"] for char in letters)
            if (
                active is not None
                and previous is not None
                and not matched
                and abs(size / font_size - 1) <= CAPTION_FONT_TOLERANCE
                and 0 <= line["top"] - previous["bottom"] <= size * CAPTION_LINE_GAP_RATIO
                and not any(
                    contains(region.bounds, line)
                    and start_bounds is not None
                    and start_bounds[1]
                    < region.bounds[1] + (region.bounds[3] - region.bounds[1]) * UPPER_REGION_RATIO
                    for region in regions
                )
            ):
                captions[active] = (
                    union(captions[active][0], bounds_of(line)),
                    captions[active][1],
                )
                previous = line
            else:
                active = None
    return captions


def _column_limits(page: Page, caption: Bounds) -> tuple[float, float]:
    left, _, right, _ = page.bbox
    for box in page.objects.get(TEXT_BOX, ()):
        if box["x1"] - box["x0"] < page.width * MIN_COLUMN_WIDTH_RATIO:
            continue
        if box["x1"] < caption[0] - COLUMN_ALIGNMENT_TOLERANCE:
            left = max(left, box["x1"] + REGION_PADDING)
        if box["x0"] > caption[2] + COLUMN_ALIGNMENT_TOLERANCE:
            right = min(right, box["x0"] - REGION_PADDING)
    return left, right


def _caption_figures(
    page: Page,
    chars: list[dict],
    regions: list[Region],
    captions: list[tuple[Bounds, str]],
) -> list[Region]:
    retained = list(regions)
    for caption, kind in captions:
        if kind != PDF_FIGURE:
            continue
        column_left, column_right = _column_limits(page, caption)
        related = [
            region
            for region in retained
            if region.kind == PDF_FIGURE
            and region.bounds[0] < column_right
            and region.bounds[2] > column_left
            and region.bounds[1] < caption[3]
            and (
                nearby(region.bounds, caption, 0)
                or min(
                    abs(region.bounds[3] - caption[1]),
                    abs(region.bounds[1] - caption[3]),
                )
                <= CAPTION_GAP
            )
        ]
        if related:
            figure_bounds = related[0].bounds
            for region in related[1:]:
                figure_bounds = union(figure_bounds, region.bounds)
            if caption[2] - caption[0] >= page.width * FIGURE_WIDE_CAPTION_RATIO and (
                figure_bounds[0] <= page.bbox[0] + REGION_PADDING
                or figure_bounds[2] >= page.bbox[2] - REGION_PADDING
            ):
                figure_bounds = (
                    max(figure_bounds[0], caption[0]),
                    figure_bounds[1],
                    min(figure_bounds[2], caption[2]),
                    figure_bounds[3],
                )
            if figure_bounds[1] <= page.bbox[1] + REGION_PADDING:
                upper_labels = [
                    bounds_of(line)
                    for line in page.objects.get(TEXT_LINE, ())
                    if line["bottom"] < caption[1]
                    and _horizontal_overlap(bounds_of(line), figure_bounds) > 0
                ]
                if upper_labels:
                    figure_bounds = (
                        figure_bounds[0],
                        max(
                            figure_bounds[1],
                            min(label[1] for label in upper_labels) - REGION_PADDING,
                        ),
                        figure_bounds[2],
                        figure_bounds[3],
                    )
            if figure_bounds[1] < caption[1] < figure_bounds[3]:
                caption_ratio = (caption[1] - figure_bounds[1]) / (
                    figure_bounds[3] - figure_bounds[1]
                )
                if caption_ratio < FIGURE_CAPTION_SIDE_RATIO:
                    figure_bounds = (
                        figure_bounds[0],
                        caption[3] + REGION_PADDING,
                        figure_bounds[2],
                        figure_bounds[3],
                    )
                else:
                    figure_bounds = (
                        figure_bounds[0],
                        figure_bounds[1],
                        figure_bounds[2],
                        caption[1] - REGION_PADDING,
                    )
            retained = [region for region in retained if region not in related]
            if _substantial(figure_bounds, page):
                retained.append(Region(figure_bounds, PDF_FIGURE, CAPTION_FIGURE_REASON))
            continue
        top = page.bbox[1] + page.height * FIGURE_PAGE_MARGIN_RATIO
        labels = 0
        for line in page.objects.get(TEXT_LINE, ()):
            line_bounds = bounds_of(line)
            if line_bounds[3] >= caption[1] or _horizontal_overlap(line_bounds, caption) <= 0:
                continue
            text = _line_text(_line_chars(line, chars)).replace(" ", "")
            if (
                len(text) >= FIGURE_BODY_MIN_CHARACTERS
                and line_bounds[0] - column_left <= FIGURE_BODY_ALIGNMENT_TOLERANCE
                and line_bounds[2] - line_bounds[0]
                >= (column_right - column_left) * FIGURE_BODY_MIN_WIDTH_RATIO
            ):
                top = max(top, line_bounds[3] + REGION_PADDING)
            elif text:
                labels += 1
        if labels < FIGURE_INFERENCE_MIN_LABELS:
            continue
        inferred = (column_left, top, column_right, caption[1] - REGION_PADDING)
        if _substantial(inferred, page):
            retained.append(Region(inferred, PDF_FIGURE, CAPTION_FIGURE_REASON))
    return retained


def _figure_labels(
    page: Page, chars: list[dict], regions: list[Region], captions: list[tuple[Bounds, str]]
) -> list[Region]:
    retained = []
    for region in regions:
        if region.kind != PDF_FIGURE:
            retained.append(region)
            continue
        related = [
            caption
            for caption, kind in captions
            if kind == PDF_FIGURE and nearby(caption, region.bounds, CAPTION_GAP)
        ]
        if (
            not related
            and region.reason == VECTOR_REASON
            and any(
                contains(region.bounds, line)
                and len(_line_text(_line_chars(line, chars)).split()) >= PROSE_LINE_WORDS
                for line in page.objects.get(TEXT_LINE, ())
            )
        ):
            # A frame around a theorem/callout is not sufficient figure evidence.
            continue
        column_left, column_right = _column_limits(page, region.bounds)
        if related:
            for box in page.objects.get(TEXT_BOX, ()):
                box_bounds = bounds_of(box)
                text = box.get("text", "").strip()
                if (
                    not text
                    or len(text) > MAX_LABEL_CHARACTERS
                    or sum(any(char.isalnum() for char in word) for word in text.split())
                    > MAX_LABEL_WORDS
                    or not nearby(region.bounds, box_bounds, LABEL_GAP)
                    or any(nearby(box_bounds, caption, 0) for caption, _ in captions)
                    or box_bounds[0] < column_left
                    or box_bounds[2] > column_right
                    or any(
                        prose is not box
                        and len(prose.get("text", "").split()) >= PROSE_LINE_WORDS
                        and (
                            nearby(box_bounds, bounds_of(prose), 0)
                            or (
                                prose["x0"] <= (box_bounds[0] + box_bounds[2]) / 2 <= prose["x1"]
                                and (
                                    box_bounds[3] <= prose["top"] < region.bounds[1]
                                    or region.bounds[3] < prose["bottom"] <= box_bounds[1]
                                )
                            )
                        )
                        for prose in page.objects.get(TEXT_BOX, ())
                    )
                    or (
                        region.bounds[0] <= box_bounds[0] <= box_bounds[2] <= region.bounds[2]
                        and region.bounds[1] <= box_bounds[1] <= box_bounds[3] <= region.bounds[3]
                    )
                ):
                    continue
                # Caption text is a hard outer boundary; labels do not extend into
                # the prose on the other side of the caption.
                if any(
                    (caption[1] >= region.bounds[3] and box_bounds[3] >= caption[1])
                    or (caption[3] <= region.bounds[1] and box_bounds[1] <= caption[3])
                    for caption in related
                ):
                    continue
                # A label's own rectangle is excluded. Enlarging the plot rectangle
                # would also erase unrelated prose between the label and the plot.
                retained.append(
                    Region(
                        box_bounds,
                        region.kind,
                        region.reason,
                        interactive=False,
                    )
                )
        retained.append(region)
    return retained


def _ruled_caption_tables(page: Page, captions: list[tuple[Bounds, str]]) -> list[Region]:
    regions = []
    for caption, kind in captions:
        if kind != PDF_TABLE:
            continue
        groups: list[list[Bounds]] = []
        for edge in sorted(page.horizontal_edges, key=lambda item: item["top"]):
            bounds = bounds_of(edge)
            if (
                bounds[2] - bounds[0] < page.width * MIN_REGION_WIDTH_RATIO
                or bounds[2] < caption[0]
                or bounds[0] > caption[2]
                or min(abs(bounds[1] - caption[1]), abs(bounds[1] - caption[3]))
                > page.height * TABLE_SEARCH_HEIGHT_RATIO
                or caption[1] <= bounds[1] <= caption[3]
            ):
                continue
            group = next(
                (
                    group
                    for group in groups
                    if abs(group[-1][0] - bounds[0]) <= RULE_ALIGNMENT_TOLERANCE
                    and abs(group[-1][2] - bounds[2]) <= RULE_ALIGNMENT_TOLERANCE
                    and bounds[1] - group[-1][3] <= page.height * MAX_RULE_GAP_RATIO
                    and not any(
                        group[-1][3] < other[1] < bounds[1]
                        and (
                            bounds[0] <= (other[0] + other[2]) / 2 <= bounds[2]
                            or other[0] <= (bounds[0] + bounds[2]) / 2 <= other[2]
                        )
                        for other, _ in captions
                    )
                ),
                None,
            )
            if group is None:
                groups.append([bounds])
            elif abs(group[-1][1] - bounds[1]) > RULE_ALIGNMENT_TOLERANCE:
                group.append(bounds)
        for group in groups:
            if len(group) < MIN_TABLE_RULES:
                continue
            bounds = union(group[0], group[-1])
            if min(abs(bounds[3] - caption[1]), abs(bounds[1] - caption[3])) <= CAPTION_GAP:
                regions.append(Region(bounds, PDF_TABLE, TABLE_REASON))
    return regions


def _caption_tables(page: Page, captions: list[tuple[Bounds, str]]) -> list[Region]:
    regions = []
    words = page.extract_words()
    for caption, kind in captions:
        if kind != PDF_TABLE:
            continue
        column_left, column_right = _column_limits(page, caption)
        # Both above- and below-caption tables occur in papers. Stay inside the
        # caption's column; an adjacent column must never widen the candidate.
        candidates = sorted(
            (
                word
                for word in words
                if column_left <= word["x0"]
                and word["x1"] <= column_right
                and not contains(caption, word)
                and min(abs(word["bottom"] - caption[1]), abs(word["top"] - caption[3]))
                <= page.height * TABLE_SEARCH_HEIGHT_RATIO
            ),
            key=lambda word: (word["top"], word["x0"]),
        )
        lines: list[list[dict]] = []
        for word in candidates:
            if lines and abs(word["top"] - lines[-1][0]["top"]) <= TABLE_LINE_TOLERANCE:
                lines[-1].append(word)
            else:
                lines.append([word])
        runs: list[list[tuple[Bounds, list[list[dict]]]]] = []
        for line in lines:
            cells: list[list[dict]] = []
            for word in sorted(line, key=lambda item: item["x0"]):
                if cells and word["x0"] - cells[-1][-1]["x1"] < TABLE_CELL_GAP:
                    cells[-1].append(word)
                else:
                    cells.append([word])
            row_bounds = bounds_of(line[0])
            for word in line[1:]:
                row_bounds = union(row_bounds, bounds_of(word))
            eligible = len(cells) >= MIN_TABLE_COLUMNS and all(
                len(cell) <= MAX_CELL_WORDS for cell in cells
            )
            if not eligible:
                # Prose is a hard boundary, even if another aligned row follows it.
                runs.append([])
                continue
            if not runs or (runs[-1] and row_bounds[1] - runs[-1][-1][0][3] > TABLE_ROW_GAP):
                runs.append([])
            runs[-1].append((row_bounds, cells))
        for run in runs:
            if len(run) < MIN_TABLE_ROWS:
                continue
            numeric_rows = sum(
                sum(
                    bool(NUMERIC_CELL.search(" ".join(word["text"] for word in cell)))
                    for cell in cells
                )
                >= MIN_TABLE_NUMERIC_CELLS
                for _, cells in run
            )
            if numeric_rows / len(run) < MIN_NUMERIC_ROW_RATIO:
                continue
            bounds = run[0][0]
            for row_bounds, _ in run[1:]:
                bounds = union(bounds, row_bounds)
            gap = min(abs(bounds[3] - caption[1]), abs(bounds[1] - caption[3]))
            if gap > CAPTION_GAP:
                continue
            # Require a repeated column boundary, not merely short/numeric prose.
            anchors = [cell[0]["x0"] for cell in run[0][1]]
            aligned = sum(
                sum(
                    any(abs(cell[0]["x0"] - anchor) <= COLUMN_ALIGNMENT_TOLERANCE for cell in cells)
                    for anchor in anchors
                )
                >= MIN_TABLE_COLUMNS
                for _, cells in run
            )
            if aligned / len(run) >= MIN_NUMERIC_ROW_RATIO:
                regions.append(Region(bounds, PDF_TABLE, SUSPECTED_TABLE_REASON))
    return regions


def classify(page: Page, chars: list[dict], *, images: tuple[Bounds, ...]) -> Layout:
    regions = _images(page, images)
    regions.extend(region for detector in REGION_DETECTORS for region in detector(page))
    captions = _captions(page, chars, regions)
    regions = _caption_figures(page, chars, regions, captions)
    regions = _figure_labels(page, chars, regions, captions)
    regions.extend(_ruled_caption_tables(page, captions))
    regions.extend(_caption_tables(page, captions))
    regions.extend(_formulas(page, chars, regions))
    caption_figures = [
        region
        for region in regions
        if region.kind == PDF_FIGURE
        and region.reason == CAPTION_FIGURE_REASON
        and region.interactive
    ]
    regions = [
        region
        for region in regions
        if region.kind != PDF_TABLE
        or not any(_coverage(region.bounds, figure.bounds) >= 0.8 for figure in caption_figures)
    ]
    # Prefer the more specific table classification for overlapping vector outlines.
    regions = [
        region
        for region in regions
        if region.kind == PDF_TABLE
        or not any(
            other.kind == PDF_TABLE
            and nearby(region.bounds, other.bounds, REGION_PADDING)
            and abs(region.bounds[0] - other.bounds[0]) <= GRAPHIC_JOIN_GAP
            and abs(region.bounds[2] - other.bounds[2]) <= GRAPHIC_JOIN_GAP
            for other in regions
        )
    ]
    left, top, right, bottom = page.bbox
    return Layout(
        tuple(
            Region(
                (
                    max(left, region.bounds[0] - REGION_PADDING),
                    max(top, region.bounds[1] - REGION_PADDING),
                    min(right, region.bounds[2] + REGION_PADDING),
                    min(bottom, region.bounds[3] + REGION_PADDING),
                ),
                region.kind,
                region.reason,
                region.text_policy,
                region.interactive,
            )
            for region in regions
        ),
        tuple(bounds for bounds, _ in captions),
    )


def _coverage(inner: Bounds, outer: Bounds) -> float:
    overlap_width = _horizontal_overlap(inner, outer)
    overlap_height = max(0.0, min(inner[3], outer[3]) - max(inner[1], outer[1]))
    area = (inner[2] - inner[0]) * (inner[3] - inner[1])
    return overlap_width * overlap_height / area if area > 0 else 0.0
