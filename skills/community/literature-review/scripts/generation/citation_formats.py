#!/usr/bin/env scholarseed-skill-python
"""
citation_formats.py — turn `\\cite{key}` into rendered citations, without LaTeX.

On the LaTeX path a citation is somebody else's problem: the drafts carry
`\\cite{}`, natbib and a `.bst` do the rest, and the style the user asked for is
a filename. The Markdown path deliberately has no BibTeX/Pandoc dependency, so
the last stage of that path has to do the job itself: replace every
`\\cite{key}` with what the chosen style would have printed, and emit a matching
reference list.

The Markdown layouts are deterministic, deliberately simplified renderers.
They preserve citation family, ordering and major field placement; they are not
publisher-conformance engines. Exact IEEE/ACM output is the LaTeX/PDF path using
the vendored `.bst` files.

WHY THE DRAFTS STILL CARRY `\\cite{}` ON BOTH PATHS

One citation syntax survives the whole pipeline in both dialects — the drafting
validator's whitelist check, the table builder's captions, the quality check's
citation density, the verification stage's cite-key extraction all key off
`\\cite[tp]?{...}`. Resolving to rendered text earlier would fork every one of
them. So resolution happens exactly once, here, at the very end, against a
document that is otherwise finished.

WHAT A "STYLE" ACTUALLY CHANGES

Three things, and they are independent:

  inline form   `[1]` for the numeric family, `(Smith et al., 2020)` for
                author-year.
  numbering     citation order (numeric, ieee) or alphabetical-by-author order
                (acm) — so an acm document's `[1]` is not the first paper cited,
                it is the first paper alphabetically.
  entry layout  where the year sits, whether the title is quoted, whether given
                names are initials.

`author_year` has no numbers at all, which is why the resolver assigns them in a
separate pass from rendering: the acm ordering cannot be known until every key
in the document has been seen.

METADATA IT READS

`03_process/references.bib` — the corpus bibliography frozen by
`scripts/processing/build_bib.py`. Not `05_generation/citations.bib`, which is a
selection out of the same file: reading the source avoids depending on whether
the selection step ran. A key that is in neither is reported, never guessed at.

Usage (also the way to eyeball a style before shipping it):

    scholarseed-skill-python scripts/generation/citation_formats.py <references.bib> \\
        --style ieee [--keys KEY1,KEY2]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

__all__ = [
    "BibEntry", "parse_bib_file", "parse_bib_text",
    "CitationResolver", "STYLES",
]


# How many authors a reference entry prints before it truncates. Matches the
# cap baked into assets/unsrtnat_scholarseed.bst, so the two paths do not disagree
# about the same paper.
_AUTHOR_CAP = 10


# ---------------------------------------------------------------------------
# BibTeX parsing
# ---------------------------------------------------------------------------
# Deliberately a balanced-brace walk rather than a line or blank-line split:
# `render_bibtex_entry` injects multi-line `abstract` and `tldr` fields, and a
# naive split cuts those in half and takes the rest of the entry with them.

_ENTRY_HEAD_RE = re.compile(r"@(\w+)\s*\{\s*([^,\s]+)\s*,")
_FIELD_HEAD_RE = re.compile(r"(\w+)\s*=\s*")


class BibEntry:
    """One bibliography record, normalised enough for any of the four styles.

    `authors` is a list of `(given, family)` pairs — split here rather than in
    each renderer because the two BibTeX author conventions ("Last, First" and
    "First Last") have to be told apart once, and getting it wrong turns
    "Vaswani" into "Ashish" in every entry at once.
    """

    __slots__ = ("key", "entry_type", "fields", "authors", "title", "venue", "year",
                 "doi", "url", "volume", "number", "pages", "publisher")

    def __init__(self, key: str, entry_type: str, fields: dict[str, str]):
        self.key = key
        self.entry_type = entry_type.lower()
        self.fields = dict(fields)
        self.authors = _split_authors(fields.get("author", ""))
        self.title = fields.get("title", "").strip().rstrip(".")
        # booktitle before journal: an arXiv preprint later accepted somewhere
        # carries the real venue in booktitle and the literal "ArXiv" in journal.
        self.venue = (fields.get("booktitle") or fields.get("journal")
                      or fields.get("school") or fields.get("institution") or "").strip()
        self.year = fields.get("year", "").strip()
        self.doi = fields.get("doi", "").strip()
        self.url = fields.get("url", "").strip()
        self.volume = fields.get("volume", "").strip()
        self.number = fields.get("number", "").strip()
        self.pages = fields.get("pages", "").strip().replace("--", "–")
        self.publisher = fields.get("publisher", "").strip()

    # -- name views the renderers ask for -----------------------------------

    @property
    def families(self) -> list[str]:
        return [fam for _, fam in self.authors if fam]

    def short_author(self) -> str:
        """The in-text label: `Smith`, `Smith and Jones`, `Smith et al.`."""
        fams = self.families
        if not fams:
            return self.key
        if len(fams) == 1:
            return fams[0]
        if len(fams) == 2:
            return f"{fams[0]} and {fams[1]}"
        return f"{fams[0]} et al."

    def sort_key(self) -> tuple:
        fams = self.families
        return ((fams[0] if fams else self.key).lower(), self.year, self.title.lower())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<BibEntry {self.key} {self.year}>"


def _split_authors(raw: str) -> list[tuple[str, str]]:
    """`"Vaswani, Ashish and Noam Shazeer"` -> `[("Ashish","Vaswani"), ("Noam","Shazeer")]`."""
    out: list[tuple[str, str]] = []
    for name in re.split(r"\s+and\s+", raw or ""):
        name = _clean_value(name)
        if not name:
            continue
        if "," in name:
            family, given = (p.strip() for p in name.split(",", 1))
        else:
            parts = name.split()
            if len(parts) == 1:
                family, given = parts[0], ""
            else:
                family, given = parts[-1], " ".join(parts[:-1])
        out.append((given, family))
    return out


def _clean_value(value: str) -> str:
    """Strip the LaTeX a BibTeX field carries that markdown has no use for."""
    value = value.strip()
    value = re.sub(r"\\(?:emph|textit|textbf|texttt|mbox)\{([^}]*)\}", r"\1", value)
    value = value.replace("\\&", "&").replace("\\%", "%").replace("\\_", "_")
    value = value.replace("\\#", "#").replace("\\$", "$")
    value = value.replace("\\textasciitilde{}", "~").replace("~", " ")
    value = value.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", value).strip()


def _parse_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    i = 0
    while i < len(body):
        head = _FIELD_HEAD_RE.search(body, i)
        if not head:
            break
        name = head.group(1).lower()
        start = head.end()
        if start >= len(body):
            break
        char = body[start]
        if char == "{":
            depth, j = 1, start + 1
            while j < len(body) and depth:
                if body[j] == "{":
                    depth += 1
                elif body[j] == "}":
                    depth -= 1
                j += 1
            value, i = body[start + 1:j - 1], j
        elif char == '"':
            j = start + 1
            while j < len(body) and body[j] != '"':
                j += 2 if body[j] == "\\" and j + 1 < len(body) else 1
            value, i = body[start + 1:j], j + 1
        else:
            j = start
            while j < len(body) and body[j] not in ",}\n":
                j += 1
            value, i = body[start:j], j
        while i < len(body) and body[i] in ", \t\r\n":
            i += 1
        fields[name] = _clean_value(value)
    return fields


def parse_bib_text(text: str) -> dict[str, BibEntry]:
    entries: dict[str, BibEntry] = {}
    i = 0
    while i < len(text):
        head = _ENTRY_HEAD_RE.search(text, i)
        if not head:
            break
        key, start, depth = head.group(2), head.end(), 1
        j = start
        while j < len(text) and depth:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        entries[key] = BibEntry(key, head.group(1), _parse_fields(text[start:j - 1]))
        i = j
    return entries


def parse_bib_file(path: Path) -> dict[str, BibEntry]:
    """Parse a .bib. A missing file returns `{}` — the caller reports the
    consequence (every key unresolved) rather than crashing on the cause."""
    path = Path(path)
    if not path.is_file():
        return {}
    return parse_bib_text(path.read_text(encoding="utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# Reference-entry renderers
# ---------------------------------------------------------------------------


def _initials(given: str) -> str:
    parts = [p for p in re.split(r"[\s.\-]+", given) if p]
    return " ".join(f"{p[0].upper()}." for p in parts)


def _join_names(names: list[str], oxford: bool = True) -> str:
    if not names:
        return "Anonymous"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    tail = f", and {names[-1]}" if oxford else f" and {names[-1]}"
    return ", ".join(names[:-1]) + tail


def _capped(entry: BibEntry) -> tuple[list[tuple[str, str]], bool]:
    authors = entry.authors
    if len(authors) > _AUTHOR_CAP:
        return authors[:_AUTHOR_CAP], True
    return authors, False


def _full_names(entry: BibEntry) -> str:
    authors, truncated = _capped(entry)
    names = [f"{g} {f}".strip() for g, f in authors] or ["Anonymous"]
    text = _join_names(names)
    return f"{text}, et al." if truncated else text


def _initial_names(entry: BibEntry) -> str:
    authors, truncated = _capped(entry)
    names = [f"{_initials(g)} {f}".strip() for g, f in authors] or ["Anonymous"]
    text = _join_names(names)
    return f"{text}, et al." if truncated else text


def _inverted_names(entry: BibEntry) -> str:
    """`Vaswani, A., Shazeer, N., & Polosukhin, I.` — the author-year layout."""
    authors, truncated = _capped(entry)
    if not authors:
        return "Anonymous"
    names = [f"{f}, {_initials(g)}".strip().rstrip(",") for g, f in authors]
    if truncated:
        return ", ".join(names) + ", et al."
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + f", & {names[-1]}"


def _venue_bits(entry: BibEntry) -> str:
    """`vol. 3, no. 2, pp. 10-20` — only the parts that exist."""
    bits = []
    if entry.volume:
        bits.append(f"vol. {entry.volume}")
    if entry.number:
        bits.append(f"no. {entry.number}")
    if entry.pages:
        bits.append(f"pp. {entry.pages}")
    return ", ".join(bits)


def _render_numeric(entry: BibEntry, number: int) -> str:
    parts = [f"[{number}]", f"{_full_names(entry)}."]
    if entry.title:
        parts.append(f"{entry.title}.")
    tail = ", ".join(p for p in (entry.venue, entry.year) if p)
    if tail:
        parts.append(f"{tail}.")
    if entry.doi:
        parts.append(f"doi:{entry.doi}.")
    return " ".join(parts)


def _render_ieee(entry: BibEntry, number: int) -> str:
    parts = [f"[{number}]", f"{_initial_names(entry)},"]
    if entry.title:
        parts.append(f'"{entry.title},"')
    if entry.venue:
        lead = "in " if entry.entry_type in ("inproceedings", "incollection",
                                             "conference", "proceedings") else ""
        parts.append(f"{lead}*{entry.venue}*,")
    bits = _venue_bits(entry)
    if bits:
        parts.append(f"{bits},")
    parts.append(f"{entry.year}." if entry.year else "n.d.")
    if entry.doi:
        parts.append(f"doi: {entry.doi}.")
    return " ".join(parts)


def _render_acm(entry: BibEntry, number: int) -> str:
    parts = [f"[{number}]", f"{_full_names(entry)}."]
    parts.append(f"{entry.year}." if entry.year else "[n.d.].")
    if entry.title:
        parts.append(f"{entry.title}.")
    if entry.venue:
        lead = "In " if entry.entry_type in ("inproceedings", "incollection",
                                             "conference", "proceedings") else ""
        parts.append(f"{lead}*{entry.venue}*.")
    bits = _venue_bits(entry)
    if bits:
        parts.append(f"{bits}.")
    if entry.doi:
        parts.append(f"DOI:https://doi.org/{entry.doi}")
    return " ".join(parts)


_GBT_AUTHOR_CAP = 3
_GBT_MARKERS = {
    "article": "J", "inproceedings": "C", "conference": "C",
    "proceedings": "C", "book": "M", "incollection": "M",
    "phdthesis": "D", "mastersthesis": "D", "techreport": "R",
    "misc": "EB/OL", "online": "EB/OL",
}
_GBT_CONTAINED = {"inproceedings", "conference", "incollection"}
_GBT_ONLINE_SUFFIX = '/OL'


def _render_gbt(entry: BibEntry, number: int) -> str:
    authors = []
    for given, family in entry.authors[:_GBT_AUTHOR_CAP]:
        initials = "".join(part[0].upper() for part in re.split(r"[\s.-]+", given) if part)
        authors.append(" ".join(part for part in (family, initials) if part))
    if len(entry.authors) > _GBT_AUTHOR_CAP:
        authors.append("等" if any(re.search(r"[\u3400-\u9fff]", name) for name in authors) else "et al.")
    marker = _GBT_MARKERS.get(entry.entry_type, "Z")
    if entry.fields.get('eprint') and entry.entry_type in {'misc', 'online'}:
        marker = 'PP/OL'
    if (entry.doi or entry.url) and not marker.endswith(_GBT_ONLINE_SUFFIX):
        marker += _GBT_ONLINE_SUFFIX
    title = f"{entry.title}[{marker}]"
    if entry.entry_type in _GBT_CONTAINED:
        title += f"//{entry.venue}"
    elif entry.venue:
        title += f". {entry.venue}"
    place = entry.fields.get("address") or entry.fields.get("location", "")
    publication = ": ".join(part for part in (place, entry.publisher) if part)
    date = ", ".join(part for part in (publication, entry.year) if part)
    if entry.volume:
        date += f", {entry.volume}"
    if entry.number:
        date += f"({entry.number})"
    if entry.pages:
        date += f": {entry.pages}"
    accessed = entry.fields.get("urldate") or entry.fields.get("accessed")
    if accessed:
        date += f"[{accessed}]"
    result = f"[{number}] " + ". ".join(part for part in (", ".join(authors), title, date) if part).rstrip(".") + "."
    if entry.url:
        result += f" {entry.url}."
    if entry.doi:
        result += f" DOI:{entry.doi}."
    return result


def _render_author_year(entry: BibEntry, number: int) -> str:
    del number  # author-year reference lists are not numbered
    parts = [_inverted_names(entry)]
    parts.append(f"({entry.year})." if entry.year else "(n.d.).")
    if entry.title:
        parts.append(f"{entry.title}.")
    if entry.venue:
        parts.append(f"*{entry.venue}*.")
    bits = _venue_bits(entry)
    if bits:
        parts.append(f"{bits}.")
    if entry.doi:
        parts.append(f"https://doi.org/{entry.doi}")
    return " ".join(parts)


# style -> (entry renderer, numbered?, ordering)
#   "citation"    — order of first appearance in the document
#   "alphabetic"  — sorted by first author, then year, then title
_STYLE_TABLE = {
    "gbt7714_2025": (_render_gbt, True, "citation"),
    "numeric":     (_render_numeric,     True,  "citation"),
    "ieee":        (_render_ieee,        True,  "citation"),
    "acm":         (_render_acm,         True,  "alphabetic"),
    "author_year": (_render_author_year, False, "alphabetic"),
}
STYLES = tuple(_STYLE_TABLE)


# ---------------------------------------------------------------------------
# Document resolution
# ---------------------------------------------------------------------------

_CITE_RE = re.compile(r"\\(cite|citet|citep)\*?\{([^}]*)\}")

_REFERENCES_HEADING = {
    "english": "References",
    "chinese": "参考文献",
}


class CitationResolver:
    """Two passes over one document: collect the keys, then render them.

    Two passes and not one because `acm` numbers its references alphabetically:
    the number a citation prints cannot be decided until every key in the
    document has been seen. The numeric and ieee styles would be happy with a
    single streaming pass; making all four work the same way is worth more than
    the saved scan.
    """

    def __init__(self, entries: dict[str, BibEntry], style: str,
                 language: str = "english"):
        if style not in _STYLE_TABLE:
            raise ValueError(f"unknown citation style {style!r}; expected one of {STYLES}")
        self.entries = entries
        self.style = style
        self.language = language
        self.render_entry, self.numbered, self.ordering = _STYLE_TABLE[style]
        self.order: list[str] = []          # resolved keys, reference-list order
        self.numbers: dict[str, int] = {}   # empty when the style is unnumbered
        self.unknown: list[str] = []        # cited but absent from the .bib
        self.calls = 0                      # \cite* commands seen
        self.dropped_calls = 0              # ...of which resolved to nothing

    # -- pass 1 --------------------------------------------------------------

    def collect(self, text: str) -> None:
        seen: list[str] = []
        for match in _CITE_RE.finditer(text):
            for key in (k.strip() for k in match.group(2).split(",")):
                if not key:
                    continue
                if key in self.entries:
                    if key not in seen:
                        seen.append(key)
                elif key not in self.unknown:
                    self.unknown.append(key)
        if self.ordering == "alphabetic":
            seen.sort(key=lambda k: self.entries[k].sort_key())
        self.order = seen
        self.numbers = {k: i + 1 for i, k in enumerate(seen)}

    # -- pass 2 --------------------------------------------------------------

    def rewrite(self, text: str) -> str:
        """Replace every `\\cite*{}` with the rendered inline citation.

        An unknown key is dropped rather than printed: a bracketed key the
        reader cannot look up is worse than a sentence with one fewer citation,
        and the key is reported in `unknown` either way.
        """
        def substitute(match: re.Match) -> str:
            self.calls += 1
            command = match.group(1)
            keys = [k.strip() for k in match.group(2).split(",") if k.strip()]
            keys = [k for k in keys if k in self.entries]
            if not keys:
                self.dropped_calls += 1
                return ""
            textual = command == "citet"
            return self._inline(keys, textual)

        return _CITE_RE.sub(substitute, text)

    def _inline(self, keys: list[str], textual: bool) -> str:
        if self.style == "author_year":
            return self._inline_author_year(keys, textual)
        return self._inline_numeric(keys, textual)

    def _inline_numeric(self, keys: list[str], textual: bool) -> str:
        if textual:
            # "Smith et al. [3] show..." — the label carries the sentence, the
            # number carries the lookup.
            return ", ".join(
                f"{self.entries[k].short_author()} [[{self.numbers[k]}]](#ref-{k})"
                for k in keys)
        return ", ".join(f"[[{self.numbers[k]}]](#ref-{k})" for k in keys)

    def _inline_author_year(self, keys: list[str], textual: bool) -> str:
        if textual:
            return ", ".join(
                f"[{self.entries[k].short_author()}](#ref-{k}) "
                f"({self.entries[k].year or 'n.d.'})" for k in keys)
        inner = "; ".join(
            f"[{self.entries[k].short_author()}, {self.entries[k].year or 'n.d.'}](#ref-{k})"
            for k in keys)
        return f"({inner})"

    # -- the list at the end -------------------------------------------------

    def reference_lines(self, heading_level: int = 2) -> list[str]:
        """Markdown for the reference section. Empty when nothing resolved."""
        if not self.order:
            return []
        heading = _REFERENCES_HEADING.get(self.language, _REFERENCES_HEADING["english"])
        lines = ["", "#" * heading_level + f" {heading}", ""]
        for key in self.order:
            entry = self.entries[key]
            lines.append(f'<a id="ref-{key}"></a>')
            lines.append(self.render_entry(entry, self.numbers.get(key, 0)))
            lines.append("")
        return lines

    def metrics(self) -> dict:
        """What the status row reports. Shaped the same for every style."""
        return {
            "citation_style": self.style,
            "citation_calls": self.calls,
            "citations_resolved": len(self.order),
            "citations_unresolved": sorted(self.unknown),
            "citation_calls_dropped": self.dropped_calls,
            "reference_list_numbered": self.numbered,
            "reference_list_order": self.ordering,
        }


def resolve_document(text: str, entries: dict[str, BibEntry], style: str,
                     language: str = "english",
                     heading_level: int = 2) -> tuple[str, dict]:
    """Resolve one whole document. Returns `(markdown, metrics)`.

    The reference list is appended; the caller does not add its own heading.
    """
    resolver = CitationResolver(entries, style, language)
    resolver.collect(text)
    body = resolver.rewrite(text)
    body = _tidy_after_dropped_citations(body)
    lines = [body.rstrip(), *resolver.reference_lines(heading_level)]
    return "\n".join(lines).rstrip() + "\n", resolver.metrics()


_TIDY_RULES = (
    (re.compile(r"\(\s*[;,]?\s*\)"), ""),      # "()" left by a dropped \citep
    (re.compile(r"\[\s*\]"), ""),
    (re.compile(r"[ \t]+([.,;:])"), r"\1"),
    (re.compile(r"[ \t]{2,}"), " "),
    (re.compile(r"\n{3,}"), "\n\n"),
)


def _tidy_after_dropped_citations(text: str) -> str:
    for pattern, replacement in _TIDY_RULES:
        text = pattern.sub(replacement, text)
    return text


# ---------------------------------------------------------------------------
# CLI — render a few entries in a style so a human can look at them
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bib", help="path to a .bib file (03_process/references.bib)")
    ap.add_argument("--style", default="numeric", choices=STYLES)
    ap.add_argument("--keys", default="",
                    help="comma-separated cite keys to render; default is every entry")
    ap.add_argument("--language", default="english", choices=["english", "chinese"])
    ap.add_argument("--json", action="store_true", help="emit metrics as JSON too")
    args = ap.parse_args()

    entries = parse_bib_file(Path(args.bib))
    if not entries:
        print(json.dumps({"status": "FAILED", "task": "CITATION_FORMATS",
                          "status_reason": f"no BibTeX entries parsed from {args.bib}"},
                         ensure_ascii=False))
        return 1

    keys = [k.strip() for k in args.keys.split(",") if k.strip()] or list(entries)
    probe = " ".join(f"\\citep{{{k}}}" for k in keys)
    rendered, metrics = resolve_document(probe, entries, args.style, args.language)
    print(rendered)
    if args.json:
        print(json.dumps(metrics, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
