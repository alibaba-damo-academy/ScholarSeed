"""Index explicit Markdown references without judging or rewriting model prose."""

from __future__ import annotations

import hashlib
import re

from markdown_it import MarkdownIt

INDEX_INVALID = "literature_note_index_invalid"
INDEX_BODY_LIMIT = 4 * 1024 * 1024
INDEX_STATUS = "indexed"
REFERENCE = re.compile(
    r"\[\[(?:hint:[a-z_]+\||[a-z_]+:)(?P<ids>[ABN]\d+(?:\s*,\s*[ABN]\d+)*)\]\]"
    r"|\[(?P<bare>[ABN]\d+(?:\s*,\s*[ABN]\d+)*)\]"
)


def _reference(state, silent):
    if silent or state.linkLevel:
        return False
    match = REFERENCE.match(state.src, state.pos)
    if not match:
        return False
    token = state.push("source_reference", "", 0)
    token.meta = {
        "start": state.pos,
        "end": match.end(),
        "ids": [value.strip() for value in (match["ids"] or match["bare"]).split(",")],
    }
    state.pos = match.end()
    return True


def selected_mark_ids(reading: dict) -> list[str]:
    """Read explicit embedded identities, never infer a comment from its parent."""
    try:
        identifiers = []
        for record in reading["records"]:
            for reference in record.get("source_refs", []):
                channel, raw = reference["channel"], reference.get("raw", {})
                key = raw.get("mark_id") if channel == "embedded_comment" else raw.get("id")
                if channel in ("embedded_mark", "embedded_comment"):
                    if not isinstance(key, str) or not key:
                        raise ValueError(INDEX_INVALID)
                    if key not in identifiers:
                        identifiers.append(key)
        if not identifiers:
            raise ValueError(INDEX_INVALID)
        return identifiers
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError(INDEX_INVALID) from error


def _unique(rows: list) -> dict:
    result = {}
    for row in rows:
        key = row["id"]
        if not isinstance(key, str) or not key or key in result:
            raise ValueError(INDEX_INVALID)
        result[key] = row
    return result


def index_note(text: str, reading: dict, pdf: bytes, sources: list[dict]) -> dict:
    try:
        return _index(text, reading, pdf, sources)
    except (KeyError, TypeError, AttributeError, IndexError) as error:
        raise ValueError(INDEX_INVALID) from error


def _index(text: str, reading: dict, pdf: bytes, sources: list[dict]) -> dict:
    document_hash = hashlib.sha256(pdf).hexdigest()
    if reading["document"]["sha256"] != document_hash:
        raise ValueError(INDEX_INVALID)
    catalog = _unique(reading["catalog"])
    records = _unique(reading["records"])
    lines = _unique(reading["lines"])
    aliases = reading.get("source_aliases", {})
    if not isinstance(aliases, dict) or any(
        not isinstance(key, str)
        or not isinstance(value, str)
        or value not in catalog
        or (key in catalog and key != value)
        for key, value in aliases.items()
    ):
        raise ValueError(INDEX_INVALID)
    selected = {(source["mark_id"], source["comment_id"]): source for source in sources}
    entries = {}
    for sid, entry in catalog.items():
        bound = {}
        for rid in entry.get("record_ids", []):
            for reference in records[rid].get("source_refs", []):
                raw = reference.get("raw", {})
                if reference["channel"] == "embedded_mark":
                    key = (raw["id"], None)
                elif reference["channel"] == "embedded_comment":
                    key = (raw["mark_id"], raw["id"])
                else:
                    continue
                if key in selected:
                    bound[key] = selected[key]
        paper = None
        if entry.get("kind") == "paper_text" and sources:
            page = entry["page"]
            if not isinstance(page, int) or isinstance(page, bool) or page < 1:
                raise ValueError(INDEX_INVALID)
            excerpt = "\n".join(lines[lid]["text"] for lid in entry.get("line_ids", []))
            if excerpt.strip():
                paper = {
                    "id": sid,
                    "page": page,
                    "text": excerpt,
                    **{
                        key: sources[0][key]
                        for key in ("record_target", "source_revision", "attachment_name")
                    },
                }
        entries[sid] = {
            "id": sid,
            "kind": entry.get("kind"),
            "sources": list(bound.values()),
            "paper": paper,
        }
    parser = MarkdownIt("commonmark")
    parser.inline.ruler.after("image", "source_reference", _reference)
    tokens = parser.parse(text)
    raw_lines = text.splitlines(keepends=True)
    paragraphs: list[dict[str, object]] = []
    unresolved, used = [], set()
    skipped = 0
    for position, token in enumerate(tokens):
        if token.type != "paragraph_open":
            continue
        inline = tokens[position + 1]
        children = inline.children or []
        references = []
        for number, child in enumerate(children):
            if child.type != "source_reference":
                continue
            following = next(
                (
                    value
                    for value in children[number + 1 :]
                    if value.type != "source_reference"
                    and not (value.type == "text" and not value.content.strip())
                ),
                None,
            )
            preceding = next(
                (
                    value
                    for value in reversed(children[:number])
                    if value.type != "source_reference"
                    and not (value.type == "text" and not value.content.strip())
                ),
                None,
            )
            references.append(
                {
                    **child.meta,
                    "closes_emphasis": following is not None
                    and following.type in ("em_close", "strong_close"),
                    "opens_emphasis": preceding is not None
                    and preceding.type in ("em_open", "strong_open"),
                }
            )
        if not references:
            continue
        source_map = inline.map
        if source_map is None:
            skipped += 1
            continue
        start, end = source_map
        raw = "".join(raw_lines[start:end]).rstrip("\r\n")
        # Nested containers have Markdown prefixes; leave them untouched until supported.
        if token.level != 0 or raw.replace("\r\n", "\n") != inline.content:
            skipped += 1
            continue
        bound, papers, identifiers = {}, {}, []
        display = inline.content
        replacements = []
        for reference in references:
            missing = []
            for sid in reference["ids"]:
                if sid not in identifiers:
                    identifiers.append(sid)
                entry = entries.get(aliases.get(sid, sid))
                if entry is None or (not entry["sources"] and not entry["paper"]):
                    missing.append(sid)
                    if sid not in unresolved:
                        unresolved.append(sid)
                    continue
                for source in entry["sources"]:
                    key = (source["mark_id"], source["comment_id"])
                    bound[key] = source
                    used.add(key)
                if entry["paper"]:
                    papers[entry["paper"]["id"]] = entry["paper"]
            replacements.append(
                (
                    reference["start"],
                    reference["end"],
                    "[" + ", ".join(missing) + "]" if missing else "",
                    reference,
                )
            )
        for span_start, span_end, replacement, reference in reversed(replacements):
            start, end = span_start, span_end
            if not replacement:
                if reference["closes_emphasis"] or display[end : end + 1] in (
                    "。",
                    "！",
                    "？",
                    ".",
                    "!",
                    "?",
                ):
                    while start > 0 and display[start - 1] in " \t":
                        start -= 1
                if reference["opens_emphasis"]:
                    while end < len(display) and display[end] in " \t":
                        end += 1
            display = display[:start] + replacement + display[end:]
        paragraphs.append(
            {
                "id": f"p{len(paragraphs) + 1}",
                "text": raw,
                "display_text": display.strip(),
                "source_ids": identifiers,
                "sources": list(bound.values()),
                "paper_sources": list(papers.values()),
            }
        )
    return {
        "version": 1,
        "status": INDEX_STATUS,
        "note_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "document_sha256": document_hash,
        "paragraphs": paragraphs,
        "source_catalog": list(entries.values()),
        "source_aliases": aliases,
        "unresolved_source_ids": unresolved,
        "skipped_paragraphs": skipped,
        "unreferenced_sources": [source for key, source in selected.items() if key not in used],
    }
