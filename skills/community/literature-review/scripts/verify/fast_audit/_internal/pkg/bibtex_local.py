"""Tiny zero-dep BibTeX parser for `citations.bib` produced by
`phase05_merge_full_draft.py`.

Only handles the limited shape our generator emits:

    @article{CiteKey,
      title  = {...},
      author = {...},
      year   = {2025},
      doi    = {10.xxxx/...},
      ...
    }

It is NOT a general BibTeX parser — it deliberately ignores comments outside
`@type{...}` blocks, @string macros, nested braces beyond a depth of 2, and
non-quoted values. That is fine because the only `.bib` this module reads is
the one our own merger script emits.
"""

from __future__ import annotations

import re

_ENTRY_RE = re.compile(
    r"@(?P<type>[A-Za-z]+)\s*\{\s*(?P<key>[^,\s]+)\s*,",
    re.IGNORECASE,
)

# Match `field = {value}` or `field = "value"`; value may contain balanced
# single-level braces (e.g. {LLaVA-MR: {…}}). For our generator's output this
# is sufficient.
_FIELD_RE = re.compile(
    r"(?P<name>[A-Za-z][A-Za-z0-9_-]*)\s*=\s*"
    r"(?:\{(?P<braced>(?:[^{}]|\{[^{}]*\})*)\}|\"(?P<quoted>[^\"]*)\")\s*,?",
)


def _slice_entry_body(text: str, brace_open_idx: int) -> tuple[str, int]:
    """Return (body, end_idx_exclusive) starting from the `{` after the key."""
    depth = 0
    for i in range(brace_open_idx, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[brace_open_idx + 1: i], i + 1
    # Unbalanced — return what we have to be lenient.
    return text[brace_open_idx + 1:], len(text)


def parse_bib(bib_text: str) -> dict[str, dict]:
    """Parse `citations.bib` into `{cite_key: {type, title, author, year, doi,
    arxiv, raw}}`.

    Unknown fields are dropped. Whitespace inside title/author values is
    collapsed. `arxiv` is best-effort: it pulls the eprint field if present, or
    extracts the arXiv id from a `10.48550/arxiv.XXXX.XXXXX` doi.
    """
    out: dict[str, dict] = {}
    for m in _ENTRY_RE.finditer(bib_text):
        key = m.group("key").strip()
        if not key:
            continue
        brace_pos = bib_text.find("{", m.start())
        if brace_pos == -1:
            continue
        body, _ = _slice_entry_body(bib_text, brace_pos)
        comma = body.find(",")
        if comma != -1:
            body = body[comma + 1:]

        fields: dict[str, str] = {}
        for fm in _FIELD_RE.finditer(body):
            name = fm.group("name").lower()
            value = fm.group("braced")
            if value is None:
                value = fm.group("quoted") or ""
            value = " ".join(value.split())  # collapse whitespace
            fields[name] = value

        title = fields.get("title", "")
        author = fields.get("author", "")
        year_raw = fields.get("year", "")
        try:
            year = int(re.sub(r"[^0-9]", "", year_raw)) if year_raw else None
        except ValueError:
            year = None
        doi = fields.get("doi", "") or None
        arxiv = fields.get("eprint", "") or None
        if not arxiv and doi:
            am = re.search(r"10\.48550/arxiv\.(\S+)", doi, re.IGNORECASE)
            if am:
                arxiv = am.group(1)

        out[key] = {
            "type": m.group("type").lower(),
            "title": title,
            "author": author,
            "year": year,
            "doi": doi,
            "arxiv": arxiv,
        }
    return out
