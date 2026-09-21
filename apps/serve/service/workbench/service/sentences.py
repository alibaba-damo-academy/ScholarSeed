"""Sentence boundaries and conservative continuation of positioned PDF prose."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace

from service.platform.citations import PDF_CAPTION, CitationPage, PdfFragment

SENTENCE = "sentence"
PASSAGE = "passage"
TRUNCATED = "truncated"
SPAN_WIDTH = 0.65
HONORIFICS = frozenset(("dr.", "mr.", "mrs.", "ms.", "prof."))
SENTENCE_STARTERS = frozenset(("The", "This", "That", "It", "We", "They", "However", "Next", "Our"))
TERMINATORS = frozenset("。！？!?")
CLOSERS = frozenset("\"'”’»）)]}")
ABBREVIATIONS = frozenset(
    (
        "dr",
        "mr",
        "mrs",
        "ms",
        "prof",
        "fig",
        "figs",
        "eq",
        "eqs",
        "sec",
        "secs",
        "vs",
        "al",
        "e.g",
        "i.e",
        "cf",
        "no",
        "vol",
    )
)
TOKEN = re.compile(r"[A-Za-z.]+$")
INITIALS = re.compile(r"(?:[A-Za-z]\.)+[A-Za-z]?$|[A-Z]$")
WORDS = re.compile(r"[^\W\d_]+", re.UNICODE)
BLOCK_START = re.compile(
    r"(?:\d+[.)]|[-•▪]|figure\b|fig\.|table\b|references\b|abstract\b)", re.IGNORECASE
)
MIN_PROSE_WORDS = 4
FONT_RATIO_TOLERANCE = 0.12
ALIGNMENT_TOLERANCE = 0.035
WIDTH_RATIO_MINIMUM = 0.75
PAGE_TOP_EDGE = 0.25
PAGE_BOTTOM_EDGE = 0.75
MAX_LINE_GAP = 2.5
MIN_PROSE_LINES = 2
MAX_SENTENCE_CHARACTERS = 1_200


def sentence_ends(text: str) -> list[int]:
    ends: list[int] = []
    for index, char in enumerate(text):
        if char == ".":
            if index + 1 < len(text) and not (
                text[index + 1].isspace() or text[index + 1] in CLOSERS
            ):
                continue
            token = TOKEN.search(text[:index])
            word = token.group() if token else ""
            following = text[index + 1 :].lstrip().split(maxsplit=1)
            next_word = following[0] if following else ""
            prefix = text[: index - len(word)].rstrip().split()
            initial = bool(INITIALS.fullmatch(word)) and (
                len(word) > 1 or not prefix or prefix[-1].casefold() in HONORIFICS
            )
            if (word.casefold() in ABBREVIATIONS or initial) and next_word not in SENTENCE_STARTERS:
                continue
        elif char not in TERMINATORS:
            continue
        end = index + 1
        while end < len(text) and (text[end] in CLOSERS or text[end] in TERMINATORS):
            end += 1
        if not ends or end > ends[-1]:
            ends.append(end)
    return ends


def complete(text: str) -> bool:
    value = text.rstrip()
    ends = sentence_ends(value)
    return bool(value and ends and ends[-1] == len(value))


@dataclass(frozen=True)
class SentenceBlock:
    fragments: tuple[PdfFragment, ...]
    page: int
    bounds: tuple[float, float, float, float]
    font: str
    size: float
    line_height: float
    lines: int
    rotation: int
    break_before: bool = False


def continues(left: SentenceBlock, right: SentenceBlock) -> bool:
    """Require adjacent prose, typography and a physical reading-flow boundary."""
    tail, head = left.fragments[-1], right.fragments[0]
    if right.break_before or PDF_CAPTION in (tail.kind, head.kind):
        return False
    if tail.kind == TRUNCATED or head.kind == TRUNCATED:
        return False
    if complete(tail.text) or len(tail.text) + len(head.text) + 1 > MAX_SENTENCE_CHARACTERS:
        return False
    if left.rotation or right.rotation or left.font != right.font or not left.size:
        return False
    if abs(right.size / left.size - 1) > FONT_RATIO_TOLERANCE:
        return False
    if left.lines < MIN_PROSE_LINES or len(WORDS.findall(tail.text)) < MIN_PROSE_WORDS:
        return False
    if not head.text[:1].islower() or BLOCK_START.match(head.text):
        return False
    if len(WORDS.findall(head.text)) < MIN_PROSE_WORDS:
        return False
    lx, ly, rx, by = left.bounds
    nx, ny, nr, nb = right.bounds
    width = rx - lx
    next_width = nr - nx
    if width <= 0 or min(width, next_width) / max(width, next_width) < WIDTH_RATIO_MINIMUM:
        return False
    if right.page == left.page and abs(nx - lx) <= ALIGNMENT_TOLERANCE:
        return 0 <= ny - by <= MAX_LINE_GAP * left.line_height
    column_or_page = (right.page == left.page and nx >= rx) or (
        right.page == left.page + 1 and nx <= lx + ALIGNMENT_TOLERANCE
    )
    return column_or_page and by >= PAGE_BOTTOM_EDGE and ny <= PAGE_TOP_EDGE


def reading_order(blocks: list[SentenceBlock]) -> list[SentenceBlock]:
    pages: dict[int, list[SentenceBlock]] = {}
    for block in blocks:
        pages.setdefault(block.page, []).append(block)
    ordered = []
    for page in pages.values():
        # Keep the layout engine's order for spanning headings/figures or rotation.
        if any(block.rotation or block.bounds[2] - block.bounds[0] >= SPAN_WIDTH for block in page):
            ordered.extend(page)
            continue
        columns: list[list[SentenceBlock]] = []
        for block in sorted(page, key=lambda item: item.bounds[0]):
            if columns and block.bounds[0] < max(item.bounds[2] for item in columns[-1]):
                columns[-1].append(block)
            else:
                columns.append([block])
        if len(columns) == 1:
            ordered.extend(page)
            continue
        ordered.extend(
            block for column in columns for block in sorted(column, key=lambda item: item.bounds[1])
        )
    return ordered


def _crosses_region(left: SentenceBlock, right: SentenceBlock, region: CitationPage) -> bool:
    for x0, y0, x1, y1 in region.quads:
        if left.page == right.page == region.page and right.bounds[1] >= left.bounds[3]:
            if (
                max(left.bounds[0], right.bounds[0], x0) < min(left.bounds[2], right.bounds[2], x1)
                and y1 >= left.bounds[3]
                and y0 <= right.bounds[1]
            ):
                return True
        elif (
            region.page == left.page
            and x1 > left.bounds[0]
            and x0 < left.bounds[2]
            and y1 >= left.bounds[3]
        ) or (
            region.page == right.page
            and x1 > right.bounds[0]
            and x0 < right.bounds[2]
            and y0 <= right.bounds[1]
        ):
            return True
    return False


def assemble(
    blocks: list[SentenceBlock],
    unavailable_pages: tuple[int, ...] = (),
    omitted_regions: tuple[CitationPage, ...] = (),
) -> list[PdfFragment]:
    result: list[PdfFragment] = []
    previous = None
    continuity = 0
    for block in reading_order(blocks):
        boundary = previous is not None and (
            block.break_before
            or PDF_CAPTION in (previous.fragments[-1].kind, block.fragments[0].kind)
            or any(previous.page <= page <= block.page for page in unavailable_pages)
            or any(_crosses_region(previous, block, region) for region in omitted_regions)
        )
        if boundary:
            continuity += 1
        fragments = [replace(fragment, continuity=continuity) for fragment in block.fragments]
        if (
            previous is not None
            and result
            and not boundary
            and previous.page not in unavailable_pages
            and block.page not in unavailable_pages
            and continues(previous, block)
        ):
            tail, head = result.pop(), fragments.pop(0)
            if len(tail.text) + len(head.text) + 1 <= MAX_SENTENCE_CHARACTERS:
                pages: dict[int, list] = {}
                for page in (*tail.pages, *head.pages):
                    pages.setdefault(page.page, []).extend(page.quads)
                value = tail.text + "\n" + head.text
                result.append(
                    PdfFragment(
                        "",
                        value,
                        tuple(CitationPage(page, tuple(quads)) for page, quads in pages.items()),
                        SENTENCE if complete(value) else PASSAGE,
                        tail.spans
                        + tuple(
                            replace(
                                span,
                                start=span.start + len(tail.text) + 1,
                                end=span.end + len(tail.text) + 1,
                            )
                            for span in head.spans
                        ),
                        continuity,
                    )
                )
            else:
                result.extend((tail, head))
        result.extend(fragments)
        previous = block
    return [
        replace(
            fragment,
            kind=(
                PDF_CAPTION
                if fragment.kind == PDF_CAPTION
                else SENTENCE if fragment.kind != TRUNCATED and complete(fragment.text) else PASSAGE
            ),
        )
        for fragment in result
    ]
