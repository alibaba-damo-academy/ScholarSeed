from __future__ import annotations

import hashlib
import re
from statistics import median

from service.platform.pdf import PdfCharacter, PdfPageLayout, PdfTextBlock

STRUCTURE_VERSION = "pdf-translation/structure-v1"
MAX_HEADING_CHARACTERS = 160
HEADING_SIZE_RATIO = 1.15
HEADING_BOLD_RATIO = 0.8
MAX_HEADING_LEVEL = 6
COORDINATE_PRECISION = 7
PARAGRAPH_GAP_RATIO = 0.6
PARAGRAPH_INDENT_RATIO = 0.8
BOLD_FONT = re.compile(r"bold|semibold|demi|black|heavy", re.IGNORECASE)
HEADING_NUMBER = re.compile(r"^\s*(\d+(?:\.\d+)*)(?:[.)]|\s)")
SENTENCE_END = re.compile(r"[。！？.!?;；]$")


def normalized(text: str) -> str:
    return "".join(text.split()).casefold()


def source_emphasis(source: str, characters: list[PdfCharacter], identity: str) -> list[dict]:
    folded = normalized(source)
    cursor = 0
    ranges: list[tuple[int, int]] = []
    for character in characters:
        value = normalized(character.text)
        start = folded.find(value, cursor)
        if not value or start < 0:
            continue
        end = start + len(value)
        if BOLD_FONT.search(character.font):
            if ranges and ranges[-1][1] == start:
                ranges[-1] = (ranges[-1][0], end)
            else:
                ranges.append((start, end))
        cursor = end
    return [
        {
            "id": f"{identity}:{start}:{end}",
            "start": start,
            "end": end,
            "source_text": folded[start:end],
        }
        for start, end in ranges
    ]


def paragraph_blocks(layout: PdfPageLayout) -> list[PdfTextBlock]:
    paragraphs = []
    for block in layout.blocks:
        lines = sorted(
            (
                line
                for line in layout.lines
                if block.bounds.x0 <= (line.bounds.x0 + line.bounds.x1) / 2 <= block.bounds.x1
                and block.bounds.top
                <= (line.bounds.top + line.bounds.bottom) / 2
                <= block.bounds.bottom
            ),
            key=lambda line: (line.bounds.top, line.bounds.x0),
        )
        if not lines or block.vertical:
            paragraphs.append(block)
            continue
        current = None
        previous = None
        previous_size = None
        for line in lines:
            characters = [
                char
                for char in layout.characters
                if line.bounds.intersects(char.bounds) and char.text.strip()
            ]
            size = median([char.size for char in characters]) if characters else 0
            separated = previous is not None and (
                line.bounds.top - previous.bounds.bottom
                > previous.bounds.height * PARAGRAPH_GAP_RATIO
                or (
                    previous_size is not None
                    and max(previous_size, size) > min(previous_size, size) * HEADING_SIZE_RATIO
                )
                or (
                    line.bounds.x0 - block.bounds.x0 > line.bounds.height * PARAGRAPH_INDENT_RATIO
                    and SENTENCE_END.search(previous.text.strip())
                )
            )
            if current is None or separated:
                if current is not None:
                    paragraphs.append(current)
                current = PdfTextBlock(line.text, line.bounds)
            else:
                current = PdfTextBlock(
                    current.text + "\n" + line.text, current.bounds.union(line.bounds)
                )
            previous = line
            previous_size = size
        if current is not None:
            paragraphs.append(current)
    return paragraphs


def source_structure(layout: PdfPageLayout, text: str, revision: str) -> tuple[dict, ...]:
    positions = []
    folded = ""
    for offset, character in enumerate(text):
        if not character.isspace():
            value = character.casefold()
            folded += value
            positions.extend([offset] * len(value))
    if not folded:
        return ()
    occupied: list[tuple[int, int]] = []
    matches: list[tuple[int, int, PdfTextBlock]] = []
    for block in paragraph_blocks(layout):
        quote = normalized(block.text)
        if not quote:
            continue
        start = folded.find(quote)
        while start >= 0 and any(
            start < end and start + len(quote) > begin for begin, end in occupied
        ):
            start = folded.find(quote, start + 1)
        if start >= 0:
            end = start + len(quote)
            occupied.append((start, end))
            matches.append((start, end, block))
    cursor = 0
    complete: list[tuple[int, int, PdfTextBlock | None]] = []
    for start, end, block in sorted(matches, key=lambda match: match[0]):
        if start > cursor:
            complete.append((cursor, start, None))
        complete.append((start, end, block))
        cursor = end
    if cursor < len(folded):
        complete.append((cursor, len(folded), None))
    sizes = [char.size for char in layout.characters if char.text.strip() and char.size > 0]
    body_size = median(sizes) if sizes else 0
    structure = []
    for start, end, currentBlock in complete:
        source = text[positions[start] : positions[end - 1] + 1]
        identity = hashlib.sha256(
            f"{STRUCTURE_VERSION}:{revision}:{layout.page}:{start}:{end}".encode()
        ).hexdigest()
        characters = [
            char
            for char in layout.characters
            if currentBlock and currentBlock.bounds.intersects(char.bounds) and char.text.strip()
        ]
        size = median([char.size for char in characters]) if characters else 0
        bold = sum(bool(BOLD_FONT.search(char.font)) for char in characters)
        candidate = bool(
            currentBlock
            and len(source) <= MAX_HEADING_CHARACTERS
            and not SENTENCE_END.search(source.strip())
        )
        heading = (
            candidate
            and bool(characters)
            and (
                size > body_size * HEADING_SIZE_RATIO
                or bold / len(characters) >= HEADING_BOLD_RATIO
            )
        )
        numbering = HEADING_NUMBER.match(source)
        level = min(MAX_HEADING_LEVEL, numbering[1].count(".") + 1) if heading and numbering else 1
        quads = (
            []
            if currentBlock is None
            else [
                [
                    round(currentBlock.bounds.x0 / layout.width, COORDINATE_PRECISION),
                    round(currentBlock.bounds.top / layout.height, COORDINATE_PRECISION),
                    round(currentBlock.bounds.x1 / layout.width, COORDINATE_PRECISION),
                    round(currentBlock.bounds.bottom / layout.height, COORDINATE_PRECISION),
                ]
            ]
        )
        structure.append(
            {
                "block_id": identity,
                "paragraph_id": identity,
                "source_text": source,
                "source_start": start,
                "source_quads": quads,
                "heading": heading,
                "heading_level": level,
                "heading_candidate": candidate,
                "page": layout.page,
                "emphasis": source_emphasis(source, characters, identity) if not heading else [],
            }
        )
    return tuple(structure)


def structure_context(structure: tuple[dict, ...], text: str, start: int = 0) -> list[dict]:
    end = start + len(normalized(text))
    selected = []
    for block in structure:
        positions = [
            offset
            for offset, char in enumerate(block["source_text"])
            if not char.isspace()
            for _ in char.casefold()
        ]
        first = max(start - block["source_start"], 0)
        last = min(end - block["source_start"], len(positions))
        if first >= last:
            continue
        selected.append(
            {
                **{
                    key: block[key]
                    for key in (
                        "block_id",
                        "heading",
                        "heading_level",
                        "heading_candidate",
                        "emphasis",
                    )
                },
                "source_text": block["source_text"][positions[first] : positions[last - 1] + 1],
                "source_start": block["source_start"] + first,
            }
        )
    return selected


def align_translation(
    blocks: list[dict], structure: tuple[dict, ...], *, partial: bool = False
) -> None:
    if not structure:
        return
    cursor = (0, 0)
    previous = ""
    for block in blocks:
        quote = normalized(block.get("source_text", ""))
        match = None
        for index in range(cursor[0], len(structure)):
            source = structure[index]
            start = normalized(source["source_text"]).find(
                quote, cursor[1] if index == cursor[0] else 0
            )
            if quote and start >= 0:
                match = (index, start, source)
                break
        if match is None:
            if partial:
                block["located"] = False
                continue
            raise ValueError("translation_structure_alignment")
        index, start, source = match
        if block.get("block_id") and block["block_id"] != source["block_id"]:
            if partial:
                block["located"] = False
                continue
            raise ValueError("translation_structure_identity")
        heading = source["heading"] or (
            source["heading_candidate"] and block.get("heading") is True
        )
        proposed_level = block.get("heading_level", source["heading_level"])
        level = (
            proposed_level
            if (isinstance(proposed_level, int) and not isinstance(proposed_level, bool))
            and 1 <= proposed_level <= MAX_HEADING_LEVEL
            else source["heading_level"]
        )
        emphasis = [
            mark
            for mark in source.get("emphasis", ())
            if mark["start"] < start + len(quote) and mark["end"] > start
        ]
        fully_bold = any(
            mark["start"] <= start and mark["end"] >= start + len(quote) for mark in emphasis
        )
        proposed_spans = block.get("translated_spans")
        spans = proposed_spans if isinstance(proposed_spans, list) else []
        allowed = {mark["id"] for mark in emphasis}
        valid_spans = bool(
            spans
            and all(
                isinstance(span, dict)
                and isinstance(span.get("text"), str)
                and (
                    not span.get("emphasis_id")
                    or (isinstance(span["emphasis_id"], str) and span["emphasis_id"] in allowed)
                )
                for span in spans
            )
        )
        valid_spans = valid_spans and "".join(span["text"] for span in spans) == block.get(
            "translated_text"
        )
        valid_spans = (
            valid_spans
            and {span.get("emphasis_id") for span in spans if span.get("emphasis_id")} == allowed
            and (fully_bold or any(not span.get("emphasis_id") for span in spans))
        )
        block["emphasis_complete"] = not emphasis or fully_bold or bool(valid_spans)
        block["translated_spans"] = (
            [{"text": block["translated_text"], "bold": True}]
            if fully_bold
            else (
                [
                    {
                        "text": span["text"],
                        "bold": bool(span.get("emphasis_id")),
                        "emphasis_id": span.get("emphasis_id"),
                    }
                    for span in spans
                ]
                if valid_spans
                else []
            )
        )
        block.update(
            {
                "block_id": source["block_id"],
                "source_id": f"{source['block_id']}:{start}",
                "paragraph_id": source["paragraph_id"],
                "paragraph_start": previous != source["paragraph_id"],
                "heading": heading,
                "heading_level": (
                    source["heading_level"]
                    if HEADING_NUMBER.match(source["source_text"])
                    else level
                ),
                "source_quads": (
                    source["source_quads"] if quote == normalized(source["source_text"]) else []
                ),
                "located": bool(source["source_quads"]) and not partial,
            }
        )
        cursor = (index, start + len(quote))
        previous = source["paragraph_id"]
