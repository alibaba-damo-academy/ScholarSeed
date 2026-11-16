"""Recover bibliography abstracts from bounded local PDF front matter, without models.

Only a complete, explicitly delimited abstract is exported. No body text, L1
claims, or guessed summary may stand in for a missing bibliography abstract.
"""

from __future__ import annotations

import re
from hashlib import sha256

from service.platform.pdf import pdf_document_info, pdf_document_text

ABSTRACT_MAX_PAGES = 2
ABSTRACT_MAX_CHARS = 12_000
ABSTRACT_START = re.compile(r"(?im)^[ \t]*(?:abstract\b|摘要)[ \t]*[.:：—–-]?[ \t]*(?:\n|(?=\S))")
ABSTRACT_END = re.compile(
    r"(?im)^[ \t]*(?:(?:(?:1[. \t]+|I[. \t]+)?(?:introduction|background)"
    r"|(?:1[. \t]+)?(?:引言|绪论))[ \t]*[.:：]?[ \t]*$"
    r"|(?:index terms|keywords|key words)\b|关键词)"
)


def local_abstract(payload: bytes, revision: str, attachment_id: str) -> tuple[str, dict]:
    """Read at most two pages; retain exact excerpt offsets and source identity."""
    actual = sha256(payload).hexdigest()
    if actual != revision.removeprefix("sha256:"):
        raise ValueError("abstract_source_revision_mismatch")
    count = min(ABSTRACT_MAX_PAGES, pdf_document_info(payload).page_count)
    pages = pdf_document_text(payload, page_numbers=tuple(range(1, count + 1)))
    text = "\n".join(pages)
    starts = list(ABSTRACT_START.finditer(text))
    if len(starts) != 1:
        return "", {}
    start = starts[0].end()
    end = ABSTRACT_END.search(text, start)
    if end is None:
        return "", {}
    excerpt = text[start : end.start()]
    abstract = " ".join(excerpt.split())
    if not abstract or len(abstract) > ABSTRACT_MAX_CHARS or abstract.endswith(("...", "…")):
        return "", {}
    # These are bibliographic provenance, not citation receipts or read grants.
    offsets = []
    position = 0
    for page, body in enumerate(pages, 1):
        left, right = max(start, position), min(end.start(), position + len(body))
        if right > left and text[left:right].strip():
            offsets.append({"page": page, "start": left - position, "end": right - position})
        position += len(body) + 1
    return abstract, {
        "kind": "local_pdf_abstract",
        "attachment_id": attachment_id,
        "source_revision": "sha256:" + actual,
        "pages": [part["page"] for part in offsets],
        "spans": offsets,
        "text_sha256": sha256(abstract.encode()).hexdigest(),
    }
