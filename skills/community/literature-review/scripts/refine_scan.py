#!/usr/bin/env scholarseed-skill-python
"""Compatibility scan used by the old writing review/apply interface.

Not an additional review or gate of current manuscript generation."""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Sentence enders in both scripts. CJK punctuation is full-width and carries no
# trailing space, so an ASCII-only pattern splits Chinese prose into one
# sentence per paragraph. The lookahead keeps `12.4%` and `Fig. 3` in one
# piece — a decimal split in half reads as two unverifiable numbers where the
# draft has one.
_SENTENCE_END = re.compile(r"(?<=[.!?。！？；;])(?![\d%])\s*")

# Two-to-six capitals, optionally with digits — MILP, MDP, RL, FJSP, LLM, GPT4.
_ACRONYM = re.compile(r"\b([A-Z][A-Z0-9]{1,5})\b")

# A number that is doing work in prose: a percentage, a decimal, a year, a
# count. Deliberately excludes anything inside a LaTeX command, which is
# stripped before this runs.
_NUMBER = re.compile(r"(?<![\w.])\d+(?:\.\d+)?\s*%?")

# CJK candidate terms. Chinese has no word boundaries, so a maximal-munch match
# returns whole clauses and never isolates the term: `航空公司的机务排班问题`
# comes back as one token and `排班` — the word the drift is actually in — is
# never counted. Instead take every run of Han characters and enumerate its
# 2-to-4-character windows, then let frequency do the separating.
_CJK_RUN = re.compile(r"[一-鿿]+")
_EN_TERM = re.compile(r"\b(?:[A-Z][a-z]+(?:\s+[a-z]+)?\s+)?[A-Z][a-z]{3,}\b")


def _is_wide(ch: str) -> bool:
    """True for glyphs that take two terminal cells (CJK, full-width forms)."""
    cp = ord(ch)
    return (0x1100 <= cp <= 0x115F or 0x2E80 <= cp <= 0xA4CF
            or 0xAC00 <= cp <= 0xD7A3 or 0xF900 <= cp <= 0xFAFF
            or 0xFE30 <= cp <= 0xFE6F or 0xFF00 <= cp <= 0xFF60
            or 0xFFE0 <= cp <= 0xFFE6 or 0x20000 <= cp <= 0x3FFFD)


def _cjk_ngrams(text: str) -> list[str]:
    out = []
    for run in _CJK_RUN.findall(text):
        for size in (2, 3, 4):
            for i in range(len(run) - size + 1):
                out.append(run[i:i + size])
    return out

# Function words that dominate any frequency count and say nothing about
# terminology drift.
_CJK_STOP = {
    "方法", "研究", "问题", "本文", "该方法", "可以", "进行", "以及", "因此",
    "然而", "此外", "同时", "其中", "对于", "通过", "基于", "提出", "表明",
    "结果", "分析", "模型", "算法", "系统", "数据", "文献", "综述", "工作",
    "以上", "如下", "这些", "那些", "一个", "一种", "不同", "相关", "主要",
}
_EN_STOP = {
    "This", "These", "Those", "There", "Their", "While", "Where", "Which",
    "Table", "Figure", "Section", "However", "Moreover", "Furthermore",
    "Although", "Because", "Therefore", "Recent", "Several", "Various",
}


def _strip_latex(text: str) -> str:
    """Prose only — commands, math and comments removed, cite keys kept out."""
    t = re.sub(r"(?m)(?<!\\)%.*$", " ", text)
    t = re.sub(r"\\cite[tp]?\*?(?:\[[^\]]*\])*\{[^}]*\}", " ", t)
    t = re.sub(r"\\(?:label|ref|Cref|cref|autoref|eqref|input|includegraphics)\{[^}]*\}", " ", t)
    t = re.sub(r"\$[^$]*\$", " ", t)
    t = re.sub(r"\\[a-zA-Z]+\*?", " ", t)
    return re.sub(r"[{}]", " ", t)


def _split_sections(text: str, is_markdown: bool) -> list[tuple[str, str]]:
    """[(title, body)] for the top-level sections, in document order."""
    pattern = (re.compile(r"(?m)^##[ \t]+(.+?)[ \t]*$") if is_markdown
               else re.compile(r"\\section\*?\{([^}]*)\}"))
    heads = [(m.start(), m.end(), m.group(1).strip()) for m in pattern.finditer(text)]
    out = []
    for i, (_s, end, title) in enumerate(heads):
        stop = heads[i + 1][0] if i + 1 < len(heads) else len(text)
        out.append((title, text[end:stop]))
    return out


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]


def _concentration(per_section: list[int]) -> float:
    """How unevenly a term is spread across sections, 0 (even) to 1 (all in one).

    This is the whole trick. Synonyms cannot be found lexically — 排班 and 派工
    share no character, and no clustering rule will ever put them together. But
    two names for one idea leave a signature in *where* they appear: each is
    common in the sections its author wrote and absent from the others. So the
    scan does not guess at synonyms; it ranks terms by how lopsided their
    distribution is and shows the distribution, and the pair jumps out of the
    table on sight.
    """
    total = sum(per_section)
    if total <= 0 or len(per_section) < 2:
        return 0.0
    largest = max(per_section) / total
    even = 1 / len(per_section)
    return (largest - even) / (1 - even)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workspace")
    ap.add_argument("--file", default=None,
                    help="draft to scan; defaults to full_draft_v1.tex, then .md")
    ap.add_argument("--top", type=int, default=40,
                    help="how many frequent terms to consider for clustering")
    args = ap.parse_args()

    gen = Path(args.workspace).expanduser().resolve() / "05_generation"
    if args.file:
        path = gen / args.file
    else:
        path = next((gen / n for n in ("full_draft_v1.tex", "full_draft_v1.md")
                     if (gen / n).is_file()), gen / "full_draft_v1.tex")
    if not path.is_file():
        print(f"[FAIL] draft not found: {path}", file=sys.stderr)
        return 2

    raw = path.read_text(encoding="utf-8", errors="replace")
    is_markdown = path.suffix == ".md"
    sections = _split_sections(raw, is_markdown)
    print(f"[scan] {path.name} · {len(raw)} chars · {len(sections)} top-level sections\n")

    # ---- 1. Section joins ------------------------------------------------
    print("=" * 72)
    print("1. SECTION JOINS — the last sentence before each heading, and the first after")
    print("=" * 72)
    for i in range(len(sections) - 1):
        prev_title, prev_body = sections[i]
        next_title, next_body = sections[i + 1]
        prev_sents = _sentences(_strip_latex(prev_body))
        next_sents = _sentences(_strip_latex(next_body))
        print(f"\n── {prev_title}  →  {next_title}")
        print(f"   ends:   …{prev_sents[-1][-160:] if prev_sents else '(empty)'}")
        print(f"   opens:  {next_sents[0][:160] if next_sents else '(empty)'}…")

    # ---- 2. Terminology --------------------------------------------------
    print("\n" + "=" * 72)
    print("2. TERMINOLOGY — frequent terms by section, most lopsided first.")
    print("   Two rows that are common in different sections and rare in each")
    print("   other's are the same idea under two names. That is the edit.")
    print("=" * 72)
    prose_by_section = [(t, _strip_latex(b)) for t, b in sections]
    all_prose = "\n".join(p for _, p in prose_by_section)
    if _CJK_RUN.search(all_prose):
        counts = Counter(t for t in _cjk_ngrams(all_prose) if t not in _CJK_STOP)
        # An n-gram that only ever appears inside a longer, equally frequent one
        # is that longer term's shadow, not a term of its own.
        counts = Counter({
            t: c for t, c in counts.items()
            if not any(t != o and t in o and counts[o] >= c for o in counts)
        })
        floor = 3
    else:
        counts = Counter(t for t in _EN_TERM.findall(all_prose)
                         if t.split()[0] not in _EN_STOP)
        floor = 2

    rows = []
    for term, total in counts.most_common(args.top * 4):
        if total < floor:
            break
        per = [p.count(term) for _, p in prose_by_section]
        rows.append((_concentration(per), total, term, per))
    rows.sort(key=lambda r: (-r[0], -r[1]))
    rows = rows[:args.top]

    if not rows:
        print("\n   no terms above the frequency floor")
    else:
        # CJK glyphs occupy two terminal cells, so `str.ljust` — which counts
        # characters — leaves a Chinese column ragged and unreadable.
        def pad(s: str, width: int) -> str:
            shown = sum(2 if _is_wide(ch) else 1 for ch in s)
            return s + " " * max(1, width - shown)

        width = max(14, min(28, max(
            sum(2 if _is_wide(ch) else 1 for ch in t) for _, _, t, _ in rows) + 2))
        header = "   " + pad("term", width) + "total  " + "  ".join(
            f"s{i}" for i in range(len(prose_by_section)))
        print("\n" + header)
        print("   " + "-" * (len(header) - 3))
        for conc, total, term, per in rows:
            cells = "  ".join(f"{c:2d}" for c in per)
            print(f"   {pad(term, width)}{total:5d}  {cells}   spread={1 - conc:.2f}")
        print("\n   section key: " + " · ".join(
            f"s{i}={t}" for i, (t, _) in enumerate(prose_by_section)))

    # ---- 3. Abbreviations ------------------------------------------------
    print("\n" + "=" * 72)
    print("3. ABBREVIATIONS — first use, and every later re-expansion")
    print("=" * 72)
    first_use: dict[str, str] = {}
    expansions: dict[str, list[str]] = defaultdict(list)
    for title, prose in prose_by_section:
        for acr in dict.fromkeys(_ACRONYM.findall(prose)):
            first_use.setdefault(acr, title)
            # An expansion is the acronym in parentheses right after words.
            if re.search(r"[\w一-鿿][^\n]{0,60}[（(]\s*" + re.escape(acr) + r"\s*[)）]",
                         prose):
                expansions[acr].append(title)
    if not first_use:
        print("\n   none found")
    for acr, title in sorted(first_use.items()):
        marks = expansions.get(acr) or []
        flag = "  ← expanded more than once" if len(marks) > 1 else ""
        print(f"\n   {acr:8s} first in: {title}")
        if marks:
            print(f"            expanded in: {', '.join(marks)}{flag}")

    # ---- 4. Numbers ------------------------------------------------------
    print("\n" + "=" * 72)
    print("4. NUMBERS IN PROSE — every figure a reader could check; confirm each")
    print("   traces to a cited paper rather than to the draft's own fluency")
    print("=" * 72)
    for title, prose in prose_by_section:
        hits = []
        for sent in _sentences(prose):
            if _NUMBER.search(sent):
                hits.append(sent.strip()[:150])
        if hits:
            print(f"\n── {title}")
            for h in hits:
                print(f"   · {h}")

    # ---- 5. Invariants ---------------------------------------------------
    print("\n" + "=" * 72)
    print("5. INVARIANTS — carry all of these into v2 unchanged")
    print("=" * 72)
    labels = re.findall(r"\\label\{([^}]*)\}", raw)
    keys = sorted({k.strip() for raw_keys in re.findall(r"\\cite[tp]?\*?\{([^}]*)\}", raw)
                   for k in raw_keys.split(",") if k.strip()})
    print(f"\n   sections : {len(sections)}")
    print(f"   labels   : {len(labels)}  {' '.join(labels)}")
    print(f"   cite keys: {len(keys)}")
    print(f"   (introducing a cite key not in this list is rejected outright)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
