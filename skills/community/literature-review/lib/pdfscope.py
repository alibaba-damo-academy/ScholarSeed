"""Choose a bounded body-page set before PDF layout analysis.

Selection metadata is for local diagnostics; it does not change model prompts.
The parser's PDF lock serializes the native text probe and layout analysis.
"""

from __future__ import annotations

import re
import unicodedata

import pypdfium2

PAGE_BUDGET = 40
END_PAGES = PAGE_BUDGET // 2
BOUNDARY_SCAN_PAGES = 200
MIN_REFERENCE_SIGNALS = 2
LOOKAHEAD_LINES = 30
SECTION_PREFIX = r"(?:(?:\d+(?:\.\d+)*|[IVX]+)[.\s]+)?"
REFERENCES = re.compile(
    SECTION_PREFIX + r"(?:references(?: and notes)?|bibliography|参考文献)\s*[:：]?$", re.I
)
SUPPLEMENT = re.compile(
    SECTION_PREFIX
    + r"(?:electronic supplementary information(?:\s*\(ESI\))?|supplementary (?:materials?|information)(?: for)?|supporting information|appendi(?:x|ces)(?:\s+[A-Z0-9]+)?|附录|补充材料)\s*[:：]?$",
    re.I,
)
REFERENCE_ENTRY = re.compile(r"^\s*(?:\[\d+\]|\d+[.)]?\s+[A-Z])")
YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
CONTENTS = re.compile(r"^(?:table of )?contents\s*$", re.I)


def boundary(text):
    """Require a standalone heading plus bibliography/supplement evidence."""
    lines = [
        unicodedata.normalize("NFKC", line).strip() for line in text.splitlines() if line.strip()
    ]
    # A contents list is not a body boundary, even if its references entry wraps.
    if any(CONTENTS.fullmatch(line) for line in lines):
        return None
    for i, line in enumerate(lines):
        following = lines[i + 1 : i + 1 + LOOKAHEAD_LINES]
        if REFERENCES.fullmatch(line):
            entries = sum(bool(REFERENCE_ENTRY.match(value)) for value in following)
            years = sum(bool(YEAR.search(value)) for value in following)
            if entries >= MIN_REFERENCE_SIGNALS or years >= MIN_REFERENCE_SIGNALS:
                return "references"
        if SUPPLEMENT.fullmatch(line):
            # Explicit supplement covers are stronger than a generic appendix label.
            explicit = re.search(r"(?i)(?:supplementary|supporting|补充)", line)
            if explicit and following and not any("...." in value for value in following):
                return "supplement"
    return None


def page_set(body_pages):
    if body_pages <= PAGE_BUDGET:
        return list(range(body_pages))
    return [*range(END_PAGES), *range(body_pages - END_PAGES, body_pages)]


def select(data, total):
    """Probe up to 200 pages; keep the boundary page whole to protect its prose.

    A failed lightweight probe falls back to the page budget. It must not reject
    a document that the layout extractor can still read.
    """
    found = None
    scanned = 0
    found_page = None
    previous = ""
    errors = []
    try:
        with pypdfium2.PdfDocument(data) as document:
            for index in range(min(total, len(document), BOUNDARY_SCAN_PAGES)):
                page = document[index]
                text = ""
                try:
                    textpage = page.get_textpage()
                    try:
                        text = textpage.get_text_range()
                        found = boundary(text)
                        if found:
                            found_page = index + 1
                        elif previous and any(
                            REFERENCES.fullmatch(line.strip()) for line in previous.splitlines()
                        ):
                            # A reference heading can be the last line of a page;
                            # confirm its entries on the next page without dropping
                            # the heading page's preceding body text.
                            if boundary(previous + "\n" + text) == "references":
                                found = "references"
                                found_page = index
                    finally:
                        textpage.close()
                except (pypdfium2.PdfiumError, ValueError) as exc:
                    errors.append({"page": index + 1, "error": type(exc).__name__})
                finally:
                    page.close()
                scanned = index + 1
                previous = text
                if found:
                    break
    except (pypdfium2.PdfiumError, ValueError) as exc:
        errors.append({"page": None, "error": type(exc).__name__})
    body_pages = found_page if found else total
    selected = page_set(body_pages)
    return {
        "pages": total,
        "body_pages": body_pages,
        "selected_pages": [index + 1 for index in selected],
        "boundary": {
            "kind": found,
            "page": found_page,
            "scanned_pages": scanned,
            "probe_errors": errors,
        },
    }
