"""Citation parser — local trimmed copy used only by fast-audit modules."""

import re

INLINE_CITE_RE = re.compile(
    r'\(([A-Z][a-z]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z]+))?'
    r'(?:\s*,\s*\d{4}[a-z]?)?)\)',
)
BRACKET_NUM_RE = re.compile(r'\[(\d+(?:\s*[-,]\s*\d+)*)\]')
BRACKET_KEY_RE = re.compile(r'\[([A-Z][a-zA-Z]+(?:EtAl)?\d{4}[a-z]?)\]')
REF_ENTRY_RE = re.compile(r'^\s*\[(\d+)\]\s*(.+?)$', re.MULTILINE)
DOI_RE = re.compile(
    r'(?:doi:\s*|https?://doi\.org/)(10\.\d{4,9}/[^\s\]>,;]+)', re.IGNORECASE,
)
ARXIV_RE = re.compile(
    r'(?:arxiv:\s*|https?://arxiv\.org/abs/)(\d{4}\.\d{4,5}(?:v\d+)?)',
    re.IGNORECASE,
)
URL_RE = re.compile(r'(https?://[^\s\]>,;)]+)', re.IGNORECASE)
REF_AUTHOR_YEAR_RE = re.compile(r'^(.+?)\s*[\(]\s*(\d{4}[a-z]?)\s*\)')
REF_TITLE_RE = re.compile(r'\d{4}[a-z]?\s*\)?\s*\.?\s*(.+?)\.\s')
LATEX_CITE_RE = re.compile(r'\\cite[tp]?\*?\{([^}]+)\}')


def _extract_metadata_from_ref_text(ref_text: str) -> dict:
    metadata = {
        "raw_text": ref_text.strip(),
        "authors": None, "year": None, "title": None,
        "doi": None, "arxiv_id": None, "urls": [],
    }
    m = REF_AUTHOR_YEAR_RE.search(ref_text)
    if m:
        metadata["authors"] = m.group(1).strip()
        try:
            metadata["year"] = int(re.sub(r'[a-z]', '', m.group(2)))
        except ValueError:
            pass
    m = REF_TITLE_RE.search(ref_text)
    if m:
        metadata["title"] = m.group(1).strip().rstrip(".")
    m = DOI_RE.search(ref_text)
    if m:
        metadata["doi"] = m.group(1).rstrip(".")
    m = ARXIV_RE.search(ref_text)
    if m:
        metadata["arxiv_id"] = m.group(1)
    metadata["urls"] = [u.rstrip(".,;)") for u in URL_RE.findall(ref_text)]
    return metadata


def extract_citations(text: str) -> list[dict]:
    citations: list[dict] = []
    seen_positions: set[tuple[int, int]] = set()

    def _add(ctype, raw, start, end, metadata=None):
        key = (start, end)
        if key in seen_positions:
            return
        seen_positions.add(key)
        citations.append({
            "type": ctype, "raw": raw,
            "position": (start, end), "metadata": metadata or {},
        })

    for m in REF_ENTRY_RE.finditer(text):
        meta = _extract_metadata_from_ref_text(m.group(2))
        meta["ref_number"] = int(m.group(1))
        _add("ref_entry", m.group(0).strip(), m.start(), m.end(), meta)

    for m in DOI_RE.finditer(text):
        _add("doi", m.group(0), m.start(), m.end(), {"doi": m.group(1).rstrip(".")})

    for m in ARXIV_RE.finditer(text):
        _add("arxiv", m.group(0), m.start(), m.end(), {"arxiv_id": m.group(1)})

    for m in INLINE_CITE_RE.finditer(text):
        content = m.group(1)
        meta = {}
        year_m = re.search(r'(\d{4})', content)
        if year_m:
            meta["year"] = int(year_m.group(1))
        author_part = re.sub(r',?\s*\d{4}[a-z]?', '', content).strip()
        if author_part:
            meta["authors"] = author_part
        _add("inline", m.group(0), m.start(), m.end(), meta)

    for m in BRACKET_NUM_RE.finditer(text):
        nums_str = m.group(1)
        nums: list[int] = []
        for part in nums_str.split(","):
            part = part.strip()
            if "-" in part:
                a, b = part.split("-", 1)
                nums.extend(range(int(a.strip()), int(b.strip()) + 1))
            else:
                nums.append(int(part))
        _add("bracket_num", m.group(0), m.start(), m.end(), {"ref_numbers": nums})

    for m in BRACKET_KEY_RE.finditer(text):
        _add("bracket_key", m.group(0), m.start(), m.end(), {"cite_key": m.group(1)})

    for m in LATEX_CITE_RE.finditer(text):
        keys = [k.strip() for k in m.group(1).split(",") if k.strip()]
        _add("latex_cite", m.group(0), m.start(), m.end(), {"cite_keys": keys})

    for m in URL_RE.finditer(text):
        url = m.group(1).rstrip(".,;)")
        if any(c["position"][0] <= m.start() < c["position"][1] for c in citations):
            continue
        _add("url", url, m.start(), m.end(), {"url": url})

    citations.sort(key=lambda c: c["position"][0])
    return citations


def parse_text(text: str) -> dict:
    citations = extract_citations(text)
    summary: dict = {"by_type": {}}
    for c in citations:
        ctype = c["type"]
        summary["by_type"][ctype] = summary["by_type"].get(ctype, 0) + 1
    return {
        "total_citations": len(citations),
        "citations": citations,
        "summary": summary,
    }
