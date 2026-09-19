"""Phase 6b — Sanitize LaTeX before compile (no LLM).

Walks every LaTeX/BibTeX artefact under {workspace}/05_generation/ that
phase 7 will feed to pdflatex (or xelatex), and rewrites it so the
compile cannot abort on a stray Unicode codepoint that snuck in via
upstream paper metadata, LLM output, or PDF text extraction.

The classic failure this guards against:

    LaTeX Error: Unicode character Κ (U+039A) not set up for use with LaTeX.

…where the Greek capital Kappa appears inside an author's name in
citations.bib because the upstream metadata stored "Dimitrios Κ.
Nasiopoulos" instead of an ASCII "K".

Strategy (english mode):
  1. ASCII look-alike substitution — Greek/Cyrillic letters that
     visually impersonate Latin letters → their ASCII counterpart.
  2. Typographic punctuation — smart quotes, em/en-dashes, ellipsis,
     NBSP, ligatures, zero-width chars → LaTeX source equivalents.
  3. Math symbols — common math glyphs → `\\ensuremath{...}` form so
     they render correctly in either text or math mode.
  4. Catch-all — any remaining non-ASCII char gets a
     `\\DeclareUnicodeCharacter` declaration in a generated sidecar
     `_internal/sanitize_unicode.tex` that we `\\input{}` from the v3
     preamble (after `inputenc`).

Strategy (chinese mode):
  Only zero-width / control chars are stripped; xelatex handles
  arbitrary Unicode natively, so the look-alike + punctuation passes
  are skipped to preserve CJK content.

Outputs:
  - {ws}/05_generation/_internal/sanitize_backup/<rel>     # one backup per modified file
  - {ws}/05_generation/_internal/sanitize_unicode.tex      # sidecar (english only)
  - {ws}/05_generation/_status/phase06b_sanitize_latex.json
"""
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
import shutil
import sys
import unicodedata
from collections import Counter
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
pass
from _utils import Workspace, load_json, log_script_start, write_status  # noqa: E402
from output_spec import read_output_spec  # noqa: E402


# ---------------------------------------------------------------------------
# Layer 1 — ASCII look-alikes (Greek + Cyrillic capitals/lowercase that visually
# impersonate Latin letters). These almost always come from PDF text
# extraction or OCR contamination of upstream metadata; rewriting them as
# ASCII is the right thing.
# ---------------------------------------------------------------------------
ASCII_LOOKALIKE: dict[str, str] = {
    # Greek capitals
    "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z",
    "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M",
    "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T",
    "Υ": "Y", "Χ": "X",
    # Cyrillic capitals
    "А": "A", "В": "B", "Е": "E", "К": "K",
    "М": "M", "Н": "H", "О": "O", "Р": "P",
    "С": "C", "Т": "T", "Х": "X",
    # Cyrillic lowercase
    "а": "a", "е": "e", "о": "o", "р": "p",
    "с": "c", "х": "x", "у": "y",
    # Mathematical Alphanumeric Symbols A/B (deliberately omitted —
    # presence of those usually means the surrounding context IS math
    # and rewriting would corrupt formulas).
}


# ---------------------------------------------------------------------------
# Layer 2 — Typographic punctuation that's already "rendered" at the Unicode
# level. Rewrite to LaTeX source so it portably compiles under any engine.
# ---------------------------------------------------------------------------
TYPOGRAPHIC: dict[str, str] = {
    "‘": "`",          # ‘
    "’": "'",          # ’
    "“": "``",         # “
    "”": "''",         # ”
    "–": "--",         # –
    "—": "---",        # —
    "…": "\\ldots{}",  # …
    " ": "~",          # NBSP
    "­": "",           # soft hyphen
    "​": "",           # ZWSP
    "‌": "",           # ZWNJ
    "‍": "",           # ZWJ
    "﻿": "",           # BOM
    "ﬀ": "ff",         # ﬀ
    "ﬁ": "fi",         # ﬁ
    "ﬂ": "fl",         # ﬂ
    "ﬃ": "ffi",        # ﬃ
    "ﬄ": "ffl",        # ﬄ
}


# ---------------------------------------------------------------------------
# Layer 3 — Math symbols. Wrapped in \ensuremath{} so they're safe in either
# text or math mode (no double-$ collision).
# ---------------------------------------------------------------------------
MATH_SYMBOLS: dict[str, str] = {
    "×": "\\ensuremath{\\times}",          # ×
    "÷": "\\ensuremath{\\div}",            # ÷
    "°": "\\ensuremath{^{\\circ}}",        # °
    "±": "\\ensuremath{\\pm}",             # ±
    "→": "\\ensuremath{\\rightarrow}",     # →
    "←": "\\ensuremath{\\leftarrow}",      # ←
    "↔": "\\ensuremath{\\leftrightarrow}", # ↔
    "⇒": "\\ensuremath{\\Rightarrow}",     # ⇒
    "⇐": "\\ensuremath{\\Leftarrow}",      # ⇐
    "≤": "\\ensuremath{\\leq}",            # ≤
    "≥": "\\ensuremath{\\geq}",            # ≥
    "≠": "\\ensuremath{\\neq}",            # ≠
    "≈": "\\ensuremath{\\approx}",         # ≈
    "∞": "\\ensuremath{\\infty}",          # ∞
    "•": "\\ensuremath{\\bullet}",         # •
    "·": "\\ensuremath{\\cdot}",           # ·
    "−": "-",                              # −  (math minus → ASCII)
}


ENGLISH_MAP: dict[str, str] = {
    **ASCII_LOOKALIKE,
    **TYPOGRAPHIC,
    **MATH_SYMBOLS,
}


# ---------------------------------------------------------------------------
# Layer 4 — Latin Extended → LaTeX accent macro lookup. Used by
# `declare_unicode_block()` when emitting the per-run sidecar so that
# accented author names in citations.bib render as their proper glyphs
# (\'o, \v{s}, \o, \ss, …) instead of degrading to a literal '?' under
# pdflatex + inputenc[utf8] + fontenc[T1]. Codepoints not in this map
# fall through to '?' as a true last-resort fallback.
# ---------------------------------------------------------------------------
LATIN_ACCENT_MACROS: dict[str, str] = {
    # Acute
    "á": "\\'{a}", "Á": "\\'{A}",
    "é": "\\'{e}", "É": "\\'{E}",
    "í": "\\'{i}", "Í": "\\'{I}",
    "ó": "\\'{o}", "Ó": "\\'{O}",
    "ú": "\\'{u}", "Ú": "\\'{U}",
    "ý": "\\'{y}", "Ý": "\\'{Y}",
    "ć": "\\'{c}", "Ć": "\\'{C}",
    "ń": "\\'{n}", "Ń": "\\'{N}",
    "ś": "\\'{s}", "Ś": "\\'{S}",
    "ź": "\\'{z}", "Ź": "\\'{Z}",
    "ĺ": "\\'{l}", "Ĺ": "\\'{L}",
    "ŕ": "\\'{r}", "Ŕ": "\\'{R}",
    # Grave
    "à": "\\`{a}", "À": "\\`{A}",
    "è": "\\`{e}", "È": "\\`{E}",
    "ì": "\\`{i}", "Ì": "\\`{I}",
    "ò": "\\`{o}", "Ò": "\\`{O}",
    "ù": "\\`{u}", "Ù": "\\`{U}",
    # Circumflex
    "â": "\\^{a}", "Â": "\\^{A}",
    "ê": "\\^{e}", "Ê": "\\^{E}",
    "î": "\\^{i}", "Î": "\\^{I}",
    "ô": "\\^{o}", "Ô": "\\^{O}",
    "û": "\\^{u}", "Û": "\\^{U}",
    "ŝ": "\\^{s}", "Ŝ": "\\^{S}",
    # Tilde
    "ã": "\\~{a}", "Ã": "\\~{A}",
    "ñ": "\\~{n}", "Ñ": "\\~{N}",
    "õ": "\\~{o}", "Õ": "\\~{O}",
    # Diaeresis / umlaut
    "ä": "\\\"{a}", "Ä": "\\\"{A}",
    "ë": "\\\"{e}", "Ë": "\\\"{E}",
    "ï": "\\\"{i}", "Ï": "\\\"{I}",
    "ö": "\\\"{o}", "Ö": "\\\"{O}",
    "ü": "\\\"{u}", "Ü": "\\\"{U}",
    "ÿ": "\\\"{y}", "Ÿ": "\\\"{Y}",
    # Caron / haček
    "č": "\\v{c}", "Č": "\\v{C}",
    "š": "\\v{s}", "Š": "\\v{S}",
    "ž": "\\v{z}", "Ž": "\\v{Z}",
    "ň": "\\v{n}", "Ň": "\\v{N}",
    "ř": "\\v{r}", "Ř": "\\v{R}",
    "ť": "\\v{t}", "Ť": "\\v{T}",
    "ď": "\\v{d}", "Ď": "\\v{D}",
    "ľ": "\\v{l}", "Ľ": "\\v{L}",
    # Breve
    "ă": "\\u{a}", "Ă": "\\u{A}",
    "ğ": "\\u{g}", "Ğ": "\\u{G}",
    "ŭ": "\\u{u}", "Ŭ": "\\u{U}",
    # Dot above
    "ė": "\\.{e}", "Ė": "\\.{E}",
    "ż": "\\.{z}", "Ż": "\\.{Z}",
    "ġ": "\\.{g}", "Ġ": "\\.{G}",
    "İ": "\\.{I}",
    # Macron
    "ā": "\\={a}", "Ā": "\\={A}",
    "ē": "\\={e}", "Ē": "\\={E}",
    "ī": "\\={i}", "Ī": "\\={I}",
    "ō": "\\={o}", "Ō": "\\={O}",
    "ū": "\\={u}", "Ū": "\\={U}",
    # Cedilla
    "ç": "\\c{c}", "Ç": "\\c{C}",
    "ş": "\\c{s}", "Ş": "\\c{S}",
    "ţ": "\\c{t}", "Ţ": "\\c{T}",
    # Ogonek
    "ą": "\\k{a}", "Ą": "\\k{A}",
    "ę": "\\k{e}", "Ę": "\\k{E}",
    # Special letters (no base + accent decomposition)
    "ø": "\\o", "Ø": "\\O",
    "ł": "\\l", "Ł": "\\L",
    "ß": "\\ss",
    "å": "\\aa", "Å": "\\AA",
    "æ": "\\ae", "Æ": "\\AE",
    "œ": "\\oe", "Œ": "\\OE",
    "đ": "\\dj", "Đ": "\\DJ",
    "ð": "\\dh", "Ð": "\\DH",
    "þ": "\\th", "Þ": "\\TH",
    "ı": "\\i",
    "ŋ": "\\ng", "Ŋ": "\\NG",
}

# Whitespace/control invisibles applied even in chinese (xelatex) mode.
WHITESPACE_INVISIBLES: dict[str, str] = {
    "­": "",
    "​": "",
    "‌": "",
    "‍": "",
    "﻿": "",
}


# ---------------------------------------------------------------------------
# Layer 5 — Cyrillic → Latin transliteration. Applied in CHINESE (xelatex)
# mode as well as english mode. ctexart's main/Latin font (Latin Modern) and
# its CJK font cover ASCII + CJK but NOT Cyrillic, so a Cyrillic author name
# in citations.bib (e.g. "Андрій Якимів") parses fine but hits "Missing
# character" at typeset time and silently renders blank. xelatex handling
# "arbitrary Unicode natively" only means it won't *abort* — it still needs a
# glyph in the active font. Romanizing to Latin guarantees a readable,
# non-blank rendering on any TeX install without depending on a Cyrillic-
# capable font being present. CJK codepoints are NOT in this map, so applying
# it in chinese mode cannot corrupt the survey's Chinese content. A roughly
# BGN/PCGN-style table covering Russian + Ukrainian letters; multi-char values
# (Zh, Kh, Shch, Ye, …) are fine with str.translate.
# ---------------------------------------------------------------------------
CYRILLIC_TRANSLIT: dict[str, str] = {
    # Uppercase
    "А": "A", "Б": "B", "В": "V", "Г": "G", "Ґ": "G", "Д": "D",
    "Е": "E", "Ё": "E", "Є": "Ye", "Ж": "Zh", "З": "Z", "И": "I",
    "І": "I", "Ї": "Yi", "Й": "Y", "К": "K", "Л": "L", "М": "M",
    "Н": "N", "О": "O", "П": "P", "Р": "R", "С": "S", "Т": "T",
    "У": "U", "Ф": "F", "Х": "Kh", "Ц": "Ts", "Ч": "Ch", "Ш": "Sh",
    "Щ": "Shch", "Ъ": "", "Ы": "Y", "Ь": "", "Э": "E", "Ю": "Yu",
    "Я": "Ya",
    # Lowercase
    "а": "a", "б": "b", "в": "v", "г": "g", "ґ": "g", "д": "d",
    "е": "e", "ё": "e", "є": "ye", "ж": "zh", "з": "z", "и": "i",
    "і": "i", "ї": "yi", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


# Files (relative to {workspace}/05_generation/) that phase 7 actually feeds
# to the LaTeX engine. Anything not in this list is left alone.
TARGET_FILES = ["full_draft_v3.tex", "citations.bib"]
TARGET_GLOBS = ["tables/*.tex", "figures/*.tex"]


def collect_files(gen: Path) -> list[Path]:
    out: list[Path] = []
    for rel in TARGET_FILES:
        p = gen / rel
        if p.exists():
            out.append(p)
    for pat in TARGET_GLOBS:
        out.extend(sorted(gen.glob(pat)))
    return out


def apply_substitutions(text: str, sub_map: dict[str, str]) -> tuple[str, Counter]:
    """Single-pass char substitution. Returns (new_text, per-codepoint counter)."""
    if not sub_map:
        return text, Counter()
    counts: Counter = Counter(ch for ch in text if ch in sub_map)
    if not counts:
        return text, counts
    # Use str.translate for the cheap path (single-char keys → multi-char vals).
    table = {ord(k): v for k, v in sub_map.items()}
    return text.translate(table), counts


# ---------------------------------------------------------------------------
# Regex-level LaTeX fixes (beyond single-char substitution). Applied to the
# .tex sources only — never citations.bib, whose BibTeX field braces and
# quoting have different semantics.
# ---------------------------------------------------------------------------
# \emph / \textit / \textsl all render italic — under xeCJK that becomes a
# fake-slant that breaks the uniform body font. Drop the wrapper, keep the
# content. \textbf (bold) is deliberately left alone: it changes weight, not
# shape. Non-nested braces only (the survey body never nests markup here).
_ITALIC_RE = re.compile(r"\\(?:emph|textit|textsl)\s*\{([^{}]*)\}")
# A lone ASCII straight double quote always renders as a RIGHT curly quote `”`
# under LaTeX, so a `"..."` pair comes out as `”...”`. Map paired ASCII quotes
# (kept on one line, no embedded `"`) to proper Chinese curly quotes “…”.
_ASCII_DQUOTE_PAIR_RE = re.compile(r'"([^"\n]*)"')


def apply_regex_fixes(text: str, language: str) -> tuple[str, Counter]:
    """LaTeX-aware fixes that single-char substitution can't express. Returns
    (new_text, per-fix counter). Caller restricts this to .tex files."""
    counts: Counter = Counter()
    text, n_italic = _ITALIC_RE.subn(r"\1", text)
    if n_italic:
        counts["italic_stripped"] = n_italic
    if language == "chinese":
        text, n_q = _ASCII_DQUOTE_PAIR_RE.subn("“\\1”", text)
        if n_q:
            counts["ascii_dquote_pairs"] = n_q
    return text, counts


def find_remaining_non_ascii(text: str) -> Counter:
    return Counter(ch for ch in text if ord(ch) > 127)


def declare_unicode_block(remaining: Counter) -> str:
    """Build a \\DeclareUnicodeCharacter block for unhandled codepoints."""
    lines = [
        "% Auto-generated by phase06b_sanitize_latex.py.",
        "% Each declaration teaches pdflatex how to render a Unicode codepoint",
        "% that survived the sanitizer's substitution pass — without this file",
        "% pdflatex would abort with 'Unicode character ... not set up for use'.",
        "% Common Latin Extended characters render as proper accent macros",
        "% (\\'o, \\v{s}, \\o, \\ss, …); only codepoints with no LaTeX accent",
        "% equivalent (CJK, emoji, exotic scripts) fall through to '?'.",
        "",
    ]
    for ch in sorted(remaining, key=ord):
        cp = f"{ord(ch):04X}"
        try:
            name = unicodedata.name(ch, "?")
        except ValueError:
            name = "?"
        replacement = LATIN_ACCENT_MACROS.get(ch, "?")
        lines.append(f"\\DeclareUnicodeCharacter{{{cp}}}{{{replacement}}}  % {name}")
    lines.append("")
    return "\n".join(lines)


def inject_preamble_input(v3_path: Path, sidecar_relpath: str) -> bool:
    """Insert `\\input{<sidecar>}` after `\\usepackage[...]{inputenc}` in the
    v3 preamble. Idempotent — returns False if the marker is already present
    or the preamble shape doesn't match expectations."""
    text = v3_path.read_text(encoding="utf-8")
    marker = f"\\input{{{sidecar_relpath}}}"
    if marker in text:
        return False

    insert_at: int | None = None

    inputenc_idx = text.find("{inputenc}")
    if inputenc_idx >= 0:
        eol = text.find("\n", inputenc_idx)
        if eol >= 0:
            insert_at = eol + 1

    if insert_at is None:
        # No inputenc line found → fall back to right after \documentclass{...}.
        dc_idx = text.find("\\documentclass")
        if dc_idx < 0:
            return False
        eol = text.find("\n", dc_idx)
        insert_at = (eol + 1) if eol >= 0 else len(text)

    new_text = (
        text[:insert_at]
        + "% phase06b_sanitize_latex sidecar — Unicode declarations\n"
        + marker
        + "\n"
        + text[insert_at:]
    )
    v3_path.write_text(new_text, encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Sanitize LaTeX/BibTeX before compile.")
    ap.add_argument("--scope")
    ap.add_argument("--language")
    args = ap.parse_args()

    ws = Workspace()
    log_script_start(ws, "phase06b_sanitize_latex",
                     language=getattr(args, "language", None))
    gen = ws.gen
    if not gen.exists():
        write_status(
            ws,
            "phase06b_sanitize_latex",
            "SUCCESS",
            message="05_generation/ does not exist; nothing to sanitize.",
        )
        return 0

    qm_path = ws.query_meta_path()
    qm = load_json(qm_path) if qm_path.exists() else {}
    language = (args.language or qm.get("language") or "english").lower()
    scope = args.scope or qm.get("scope") or "speed"

    # Every substitution below exists because a codepoint aborts a LaTeX
    # compile. On the Markdown path there is no compile and no `inputenc`, so
    # there is nothing to abort: a Greek Kappa in an author's name renders as a
    # Greek Kappa, which is what it is. Rewriting it to an ASCII "K" would
    # corrupt a name to satisfy a constraint this path does not have.
    spec = read_output_spec(ws.root)
    if spec["format"] == "markdown":
        write_status(
            ws,
            "phase06b_sanitize_latex",
            "SUCCESS",
            scope=scope,
            language=language,
            output_format=spec["format"],
            files_scanned=0,
            files_modified=0,
            total_substitutions=0,
            unique_chars_substituted=0,
            latex_fixes={},
            unhandled_non_ascii=0,
            unhandled_unique=0,
            sidecar_written=False,
            sidecar_injected=False,
            per_file=[],
            message="Markdown path — no LaTeX compile to sanitize for; skipped.",
        )
        return 0

    if language == "chinese":
        # Strip invisibles AND romanize Cyrillic — xeCJK's CJK/Latin fonts have
        # no Cyrillic glyphs, so untransliterated Cyrillic renders blank.
        sub_map = {**WHITESPACE_INVISIBLES, **CYRILLIC_TRANSLIT}
        emit_sidecar = False
    else:
        # CYRILLIC_TRANSLIT romanizes full Cyrillic words (beyond the ASCII
        # look-alikes) so they render as Latin rather than degrading to '?'.
        sub_map = {**ENGLISH_MAP, **CYRILLIC_TRANSLIT}
        emit_sidecar = True

    files = collect_files(gen)
    backup_root = gen / "_internal" / "sanitize_backup"
    backup_root.mkdir(parents=True, exist_ok=True)

    per_file: list[dict] = []
    grand_subs: Counter = Counter()
    grand_remaining: Counter = Counter()
    grand_latex_fixes: Counter = Counter()
    modified_count = 0

    for fp in files:
        original = fp.read_text(encoding="utf-8")
        new_text, counts = apply_substitutions(original, sub_map)
        # Regex-level LaTeX fixes only make sense on the .tex sources, not on the
        # BibTeX database (citations.bib), whose braces/quotes mean other things.
        latex_fixes: Counter = Counter()
        if fp.suffix == ".tex":
            new_text, latex_fixes = apply_regex_fixes(new_text, language)
        remaining = find_remaining_non_ascii(new_text)

        if new_text != original:
            rel = fp.relative_to(gen)
            backup_path = backup_root / rel
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(fp, backup_path)
            fp.write_text(new_text, encoding="utf-8")
            modified_count += 1

        entry = {
            "file": str(fp.relative_to(ws.root)),
            "modified": new_text != original,
            "substitutions": {f"U+{ord(c):04X}": n for c, n in counts.items()},
            "latex_fixes": dict(latex_fixes),
            "remaining_non_ascii_count": sum(remaining.values()),
        }
        # The per-codepoint breakdown only carries diagnostic value in english
        # mode, where it mirrors the \DeclareUnicodeCharacter sidecar. In chinese
        # mode every CJK char is "remaining" by design (xelatex renders them
        # natively, so the substitution map deliberately leaves them alone) —
        # emitting the full map there bloats the status log with thousands of
        # U+XXXX entries for no benefit. Keep just the count.
        if emit_sidecar:
            entry["remaining_non_ascii"] = {
                f"U+{ord(c):04X}": n for c, n in remaining.items()
            }
        per_file.append(entry)
        grand_subs.update(counts)
        grand_remaining.update(remaining)
        grand_latex_fixes.update(latex_fixes)

    sidecar_written = False
    sidecar_injected = False
    v3 = ws.full_draft_v3_path
    if emit_sidecar and v3.exists() and grand_remaining:
        sidecar = ws.internal_dir / "sanitize_unicode.tex"
        sidecar.write_text(declare_unicode_block(grand_remaining), encoding="utf-8")
        sidecar_written = True
        sidecar_injected = inject_preamble_input(
            v3, "05_generation/_internal/sanitize_unicode.tex"
        )

    write_status(
        ws,
        "phase06b_sanitize_latex",
        "SUCCESS",
        scope=scope,
        language=language,
        files_scanned=len(files),
        files_modified=modified_count,
        total_substitutions=sum(grand_subs.values()),
        unique_chars_substituted=len(grand_subs),
        latex_fixes=dict(grand_latex_fixes),
        unhandled_non_ascii=sum(grand_remaining.values()),
        unhandled_unique=len(grand_remaining),
        sidecar_written=sidecar_written,
        sidecar_injected=sidecar_injected,
        per_file=per_file,
        message=(
            f"Sanitized {len(files)} files ({modified_count} modified); "
            f"{sum(grand_subs.values())} char substitutions across "
            f"{len(grand_subs)} unique codepoints; "
            f"{sum(grand_remaining.values())} unhandled non-ASCII chars "
            f"declared via sidecar={sidecar_written}."
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
