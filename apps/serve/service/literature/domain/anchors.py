"""Unique, lossless alignment of immutable originals to positioned PDF text.

Only known typesetting equivalences are admitted. Unknown macros, undecoded
characters, numbers and operators never become wildcards or fuzzy matches.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from service.platform.citations import CitationPage, PdfFragment, PdfIndex

WRAPPED_HYPHEN = re.compile(r"(?<=\w)-[ \t]*\r?\n[ \t]*(?=\w)")
TEX_LITERAL = re.compile(r"\\([%&_#$])")
TEX_MATH = re.compile(r"(?<!\\)\$([^$]+)\$")
TEX_FORMAT = re.compile(r"\\(?:textbf|textit|emph|mathrm|mathbf|text)\{([^{}]*)\}")
TEX_COMMAND = re.compile(r"\\([A-Za-z]+)")
TEX_SYMBOLS = {
    "times": "×",
    "cdot": "·",
    "gg": "≫",
    "ll": "≪",
    "leq": "≤",
    "geq": "≥",
    "neq": "≠",
    "pm": "±",
}
QUOTES = {"“": '"', "”": '"', "‘": "'", "’": "'"}
QUOTE_PAIRS = {"``": '"', "''": '"'}
MAX_JOIN_FRAGMENTS = 3
MIN_JOIN_WORDS = 4
PAGE_CONTINUATION_BOTTOM = 0.70
LINE_WORD_GAP = 0.02
PAGE_HEADER_EDGE = 0.10
PAGE_FOOTER_EDGE = 0.96
PROSE_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
LAYOUT_CAPTION = re.compile(r"^(?:Table|Figure|Fig\.)\s+\d+\b", re.IGNORECASE)
SENTENCE_END = frozenset(".!?。！？")


@dataclass(frozen=True)
class Projection:
    text: str
    offsets: tuple[tuple[int, int], ...]


def project(text: str, *, unwrap: bool = False) -> Projection:
    skipped = (
        {i for match in WRAPPED_HYPHEN.finditer(text) for i in range(*match.span())}
        if unwrap
        else set()
    )
    chars: list[str] = []
    offsets: list[tuple[int, int]] = []
    position = 0
    tex_quoted = False
    while position < len(text):
        if position in skipped:
            position += 1
            continue
        pair = text[position : position + 2]
        quote_pair = (
            pair == "``"
            and (position == 0 or not text[position - 1].isalnum())
            or pair == "''"
            and tex_quoted
        )
        size = 2 if quote_pair else 1
        value = QUOTE_PAIRS[pair] if quote_pair else QUOTES.get(text[position], text[position])
        if quote_pair:
            tex_quoted = pair == "``"
        elif value == '"':
            tex_quoted = False
        for char in unicodedata.normalize("NFKC", value):
            if char.isspace():
                if not chars or chars[-1] == " ":
                    continue
                char = " "
            chars.append(char)
            offsets.append((position, position + size))
        position += size
    if chars and chars[-1] == " ":
        chars.pop()
        offsets.pop()
    return Projection("".join(chars), tuple(offsets))


def original_text(source: str) -> str:
    value = TEX_FORMAT.sub(r"\1", source)
    value = TEX_COMMAND.sub(lambda match: TEX_SYMBOLS.get(match[1], match[0]), value)
    value = TEX_MATH.sub(lambda match: match[1].replace("{", "").replace("}", ""), value)
    return project(TEX_LITERAL.sub(r"\1", value)).text


def sentence_pattern(pdf_text: str) -> re.Pattern:
    parts = WRAPPED_HYPHEN.split(pdf_text)
    return re.compile("-?".join(re.escape(project(part).text) for part in parts))


def bounded(text: str, start: int, end: int) -> bool:
    return not (
        start
        and text[start - 1].isalnum()
        and text[start].isalnum()
        or end < len(text)
        and text[end - 1].isalnum()
        and text[end].isalnum()
    )


def slice_pages(fragment: PdfFragment, start: int, end: int) -> tuple[CitationPage, ...]:
    if not fragment.spans:
        return fragment.pages if start == 0 and end == len(fragment.text) else ()
    pages: dict[int, list[tuple]] = {}
    for span in fragment.spans:
        if span.start < end and span.end > start:
            pages.setdefault(span.page, []).append(span.quad)
    return merge_pages(tuple(CitationPage(page, tuple(quads)) for page, quads in pages.items()))


def merge_pages(pages: tuple[CitationPage, ...]) -> tuple[CitationPage, ...]:
    lines: dict[int, list[tuple]] = {}
    for page in pages:
        for quad in page.quads:
            x0, y0, x1, y1 = quad
            row = lines.setdefault(page.page, [])
            previous = row[-1] if row else None
            if (
                previous
                and previous[1] == y0
                and previous[3] == y1
                and previous[0] <= x0 <= previous[2] + LINE_WORD_GAP
            ):
                row[-1] = (previous[0], y0, max(x1, previous[2]), y1)
            else:
                row.append(quad)
    return tuple(CitationPage(page, tuple(lines[page])) for page in sorted(lines))


class SentenceAnchors:
    """One prepared index for both evidence reads and historical citation clicks."""

    def __init__(self, index: PdfIndex):
        self.fragments = index.fragments
        self.patterns = tuple(sentence_pattern(fragment.text) for fragment in index.fragments)
        self.variants = tuple(
            tuple(project(fragment.text, unwrap=unwrap) for fragment in index.fragments)
            for unwrap in (False, True)
        )

    def locate(self, original: str) -> tuple[CitationPage, ...]:
        needle = original_text(original)
        if not needle:
            return ()
        candidates: dict[tuple, tuple[CitationPage, ...]] = {}
        for fragment, pattern in zip(self.fragments, self.patterns):
            if pattern.fullmatch(needle):
                pages = slice_pages(fragment, 0, len(fragment.text))
                if pages:
                    candidates[pages] = pages
        for projected in self.variants:
            for index, value in enumerate(projected):
                start = value.text.find(needle)
                while start >= 0:
                    end = start + len(needle)
                    if bounded(value.text, start, end):
                        pages = slice_pages(
                            self.fragments[index],
                            value.offsets[start][0],
                            value.offsets[end - 1][1],
                        )
                        if pages:
                            candidates[pages] = pages
                    start = value.text.find(needle, start + 1)
                # A source sentence may be a suffix of one layout fragment and a
                # prefix of the next; every source character must still be consumed.
                first = needle.split(maxsplit=1)[0]
                start = value.text.find(first)
                while start >= 0:
                    suffix = value.text[start:]
                    if (
                        len(suffix.split()) >= MIN_JOIN_WORDS
                        and needle.startswith(suffix + " ")
                        and bounded(value.text, start, len(value.text))
                        and suffix[-1] not in SENTENCE_END
                    ):
                        pages = slice_pages(
                            self.fragments[index], value.offsets[start][0], value.offsets[-1][1]
                        )
                        if pages:
                            for tail in self._continue(
                                projected, index, needle[len(suffix) + 1 :], MAX_JOIN_FRAGMENTS - 1
                            ):
                                combined = merge_pages(pages + tail)
                                candidates[combined] = combined
                    start = value.text.find(first, start + 1)
        return next(iter(candidates.values())) if len(candidates) == 1 else ()

    def _continue(
        self, projected: tuple[Projection, ...], previous: int, remaining: str, budget: int
    ):
        left = self.fragments[previous]
        page = left.pages[-1].page
        bottom = max(quad[3] for quad in left.pages[-1].quads)
        # Repeated continuations cannot identify a unique anchor even when one
        # occurrence happens to be earlier in the layout engine's ordering.
        completions = sum(
            value.text.startswith(remaining) and bounded(value.text, 0, len(remaining))
            for index, value in enumerate(projected[previous + 1 :], previous + 1)
            if self.fragments[index].pages[0].page <= page + 1
        )
        if completions > 1:
            return
        for index in range(previous + 1, len(projected)):
            right = self.fragments[index]
            next_page = right.pages[0].page
            if next_page > page + 1:
                break
            if not (
                index == previous + 1
                and next_page == page
                or next_page == page + 1
                and bottom >= PAGE_CONTINUATION_BOTTOM
            ):
                continue
            if next_page == page + 1 and any(
                self._prose(item) for item in self.fragments[previous + 1 : index]
            ):
                continue
            value = projected[index]
            if value.text.startswith(remaining) and bounded(value.text, 0, len(remaining)):
                pages = slice_pages(
                    right, value.offsets[0][0], value.offsets[len(remaining) - 1][1]
                )
                if pages:
                    yield pages
            elif budget > 1 and value.text and remaining.startswith(value.text + " "):
                pages = slice_pages(right, value.offsets[0][0], value.offsets[-1][1])
                if pages:
                    for tail in self._continue(
                        projected, index, remaining[len(value.text) + 1 :], budget - 1
                    ):
                        yield merge_pages(pages + tail)

    @staticmethod
    def _prose(fragment: PdfFragment) -> bool:
        quads = [quad for page in fragment.pages for quad in page.quads]
        return (
            len(PROSE_WORD.findall(fragment.text)) >= MIN_JOIN_WORDS
            and not LAYOUT_CAPTION.match(fragment.text)
            and max(quad[3] for quad in quads) > PAGE_HEADER_EDGE
            and min(quad[1] for quad in quads) < PAGE_FOOTER_EDGE
        )
