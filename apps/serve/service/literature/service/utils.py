"""Shared literature reading and translation projections."""

from __future__ import annotations

import re

from markdown_it import MarkdownIt

from service.platform.citations import (
    FORMULA_OPERATOR,
    FORMULA_WORD_LIMIT,
    formula_groups,
    source_box,
)

PRECISE_FIELD = re.compile(r"(?:\.results\[|\.key_formulas\[|\.main_results\[)")
TABLE_LABEL = re.compile(r"(?:Table|表)\s*(\d+(?:\.\d+)?)\b", re.I)
SOURCE_NUMBER = re.compile(r"(?<!\w)\d+(?:\.\d+)?(?:%|％)?(?!\w)")
SOURCE_WORD = re.compile(r"[^\W_]+", re.UNICODE)
FORMULA_LOOKAHEAD = 3
FORMULA_GAP = 0.035
SOURCE_BLOCK_CHARACTERS = 6_000
ASSUMPTION_REFERENCE = re.compile(r"Assumptions?\s+([\d.]+(?:\s*(?:,|and)\s*[\d.]+)*)", re.I)
ASSUMPTION_TITLE = re.compile(r"^Assumption\s+(\d+(?:\.\d+)+)\b", re.I)


def join_reading_segments(parts: list[str]) -> str:
    """Keep Markdown block starts while joining source-bound prose continuations."""
    parser = MarkdownIt("commonmark")
    joined = ""
    for part in parts:
        tokens = parser.parse(part)
        starts_block = bool(tokens) and tokens[0].type != "paragraph_open"
        separator = "\n\n" if starts_block else " "
        joined += (separator if joined else "") + part
    return joined


def translation_text(blocks: list[dict]) -> str:
    paragraphs: list[str] = []
    previous_heading = False
    for block in blocks:
        text = block.get("translated_text")
        if not isinstance(text, str) or not text.strip():
            continue
        heading = block.get("heading") is True
        if paragraphs and not (block.get("paragraph_start") is True or heading or previous_heading):
            paragraphs[-1] += " " + text.strip()
        else:
            paragraphs.append(text.strip())
        previous_heading = heading
    return "\n\n".join(paragraphs)


def table_labels(text: str) -> set[str]:
    return set(TABLE_LABEL.findall(text))


def complete_sources(fragments: dict, numbers: list[str], value=None) -> list[str]:
    direct, context = source_membership(fragments, numbers, value)
    selected = set(direct) | set(context)
    original = list(dict.fromkeys(str(n) for n in numbers))
    return [*original, *(n for n in fragments if n in selected and n not in original)]


def source_membership(
    fragments: dict, numbers: list[str], value=None
) -> tuple[list[str], list[str]]:
    """Locate complete native tables/formula rows, without interpreting their values.

    L1 tuples are only search hints. Ambiguous table matches do not become evidence.
    Existing anchors, text and geometry are never rewritten or certified as true.
    """
    numbers = list(dict.fromkeys(str(n) for n in numbers))
    selected = set(numbers)
    ordered = list(fragments)
    indexed = [{**fragments[n], "source_order": i} for i, n in enumerate(ordered)]
    equations = {
        member["source_order"]: group for group in formula_groups(indexed) for member in group
    }
    labels = set().union(
        *(table_labels(fragments[n].get("text", "")) for n in numbers if n in fragments)
    )
    tables = {
        n: f
        for n, f in fragments.items()
        if f.get("kind") == "table_text"
        and not f.get("fragment_id", "").startswith("table_partial_")
    }
    for n, f in tables.items():
        if labels & table_labels(f["text"]):
            selected.add(n)
    if isinstance(value, dict) and value.get("value") and value.get("method"):
        values = {v.rstrip("%％") for v in SOURCE_NUMBER.findall(str(value["value"]))}
        words = set(SOURCE_WORD.findall(str(value["method"]).casefold()))
        matches = [
            n
            for n, f in tables.items()
            if any(
                values
                and values <= {v.rstrip("%％") for v in SOURCE_NUMBER.findall(line)}
                and words <= set(SOURCE_WORD.findall(line.casefold()))
                for line in f["text"].splitlines()
            )
        ]
        if len(matches) == 1:
            selected.add(matches[0])
    for n in numbers:
        if n not in fragments:
            continue
        start = ordered.index(n)
        anchor = source_box(fragments[n])
        if anchor is None:
            continue
        for index in range(start, min(len(ordered), start + FORMULA_LOOKAHEAD + 1)):
            fragment = fragments[ordered[index]]
            box = source_box(fragment)
            text = fragment.get("text", "")
            if (
                box is None
                or box[0] != anchor[0]
                or box[4] < anchor[2]
                or box[2] - anchor[4] > FORMULA_GAP
                or fragment.get("kind") != "passage"
                or len(text.split()) > FORMULA_WORD_LIMIT
                or not FORMULA_OPERATOR.search(text)
            ):
                continue
            members = {ordered[part["source_order"]] for part in equations[index]}
            if sum(len(fragments[k]["text"]) for k in members) <= SOURCE_BLOCK_CHARACTERS:
                selected.update(members)
                # Retain the statement introducing this equation, including its
                # assumptions. Never reach into another paragraph or page.
                statement = fragments[n].get("continuity")
                if index > start and statement is not None:
                    for nearby in ordered[max(0, start - FORMULA_LOOKAHEAD) : index]:
                        part = fragments[nearby]
                        rect = source_box(part)
                        if part.get("continuity") == statement and rect and rect[0] == anchor[0]:
                            selected.add(nearby)
    # Resolve only assumptions explicitly named by a completed statement. One
    # hop, exact numbered definition, native paragraph boundary; no topic search.
    direct = set(selected)
    if selected != set(numbers):
        references = {
            number.rstrip(".")
            for n in selected
            if n in fragments
            for group in ASSUMPTION_REFERENCE.findall(fragments[n].get("text", ""))
            for number in re.findall(r"\d+(?:\.\d+)+", group)
        }
        for n, fragment in fragments.items():
            title = ASSUMPTION_TITLE.match(fragment.get("text", ""))
            continuity = fragment.get("continuity")
            if not title or title[1] not in references or continuity is None:
                continue
            block = [k for k, f in fragments.items() if f.get("continuity") == continuity]
            if sum(len(fragments[k]["text"]) for k in block) <= SOURCE_BLOCK_CHARACTERS:
                selected.update(block)
    # The caller applies its existing whole-record budget. Never slice an equation.
    return (
        [*numbers, *(n for n in ordered if n in direct and n not in numbers)],
        [n for n in ordered if n in selected and n not in direct],
    )
