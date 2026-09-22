"""LaTeX compile-time safety detector.

Catches the class of defects where the upstream pipeline reports "compile
succeeded" but the rendered PDF is still wrong on a reader's screen:

  1. Image placeholder text — when image generation failed (e.g. missing API
     key) and the figure subfile fell back to a literal `\\fbox{... Figure
     placeholder for F1 ...}` block, but the main draft still `\\input{}`s
     it. The PDF compiles, but the reader sees a "Figure placeholder for F1"
     box instead of the intended figure.
  2. Image references to figures that the upstream `generate_images` phase
     already marked as failed in `05_generation/_status/generate_images.json`
     — same root cause, different evidence path.
  3. Unescaped percent signs in prose — LaTeX treats `%` as a comment
     delimiter, so a literal `25%` in the body silently truncates the rest
     of the line in the PDF. The author wanted `\\%`.
  4. Table cell content overflowing column width — `tabular(x)`/`longtable`
     cells whose unbreakable text would push past the declared column width,
     causing visible overlap with the next column in the PDF. Four sub-kinds:
     long unbreakable token in fixed-width column, `&`-count vs column-spec
     mismatch, sum of fixed widths exceeding page width (or tabularx X col
     starved by fixed cols), and many-column `l/c/r` tables without any
     width-control wrapper. (A "tall cell" heuristic was prototyped but
     removed — it didn't correspond to actual PDF overfull warnings.)

All four are S-tier hard-gate concerns: the PDF compiles, the upstream
status says SUCCESS, but a downstream human will immediately notice the
problem. Any single match flips the module verdict to FAIL → REJECTED.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# 1. Literal "Figure placeholder for F1." text emitted by the figure
#    rendering fallback path.
_RE_FIGURE_PLACEHOLDER_TEXT = re.compile(
    r"Figure\s+placeholder\s+for\s+([Ff]\d+)", re.IGNORECASE
)
# 2. \fbox{... placeholder ...} pattern (covers `\fbox{\parbox{...placeholder...}}`
#    even with nested braces, as long as the outer fbox argument contains the
#    word). The non-greedy `[^{}]*` keeps the match anchored to the same
#    nesting level.
_RE_FBOX_PLACEHOLDER = re.compile(
    r"\\fbox\s*\{[^{}]*placeholder", re.IGNORECASE
)
# Unescaped percent: a `%` not preceded by a backslash. Whole-line comments
# (^\s*%) and verbatim/lstlisting/comment regions are filtered separately.
_RE_UNESCAPED_PERCENT = re.compile(r"(?<!\\)%")
# Whole-line LaTeX comment — these are intentional and not a defect.
_RE_FULL_LINE_COMMENT = re.compile(r"^\s*%")
# Verbatim-style environments whose body is rendered literally — `%` inside
# them is fine and must not be flagged.
_RE_VERBATIM_BLOCK = re.compile(
    r"\\begin\{(verbatim|lstlisting|comment|minted)\}[\s\S]*?"
    r"\\end\{\1\}",
    re.IGNORECASE,
)
# `\verb|...|` / `\verb!...!` inline verbatim. The first non-letter, non-`*`
# char after `\verb` is the delimiter.
_RE_VERB_INLINE = re.compile(r"\\verb\*?(.)(.*?)\1")


def _mask_verbatim(text: str) -> str:
    """Replace the bodies of verbatim-style regions with whitespace, keeping
    line numbers stable so any flagged `%` still points at the right line."""

    def _blank(m: re.Match[str]) -> str:
        return re.sub(r"[^\n]", " ", m.group(0))

    masked = _RE_VERBATIM_BLOCK.sub(_blank, text)
    masked = _RE_VERB_INLINE.sub(_blank, masked)
    return masked


def _check_image_placeholders(text: str, source_file: str) -> list[dict]:
    """Find literal placeholder text patterns in `text`. Returns issue dicts
    with `kind`, `file`, `line`, `snippet`, `figure_id` (if extractable)."""
    matches: list[dict] = []
    for line_num, line in enumerate(text.splitlines(), 1):
        m1 = _RE_FIGURE_PLACEHOLDER_TEXT.search(line)
        if m1:
            matches.append({
                "kind": "image_placeholder_text",
                "file": source_file,
                "line": line_num,
                "snippet": line.strip()[:160],
                "figure_id": m1.group(1),
            })
        m2 = _RE_FBOX_PLACEHOLDER.search(line)
        if m2 and not m1:
            # Avoid double-reporting the same line when both patterns hit
            # (the fallback emits both a `\fbox` and the literal text).
            matches.append({
                "kind": "image_placeholder_text",
                "file": source_file,
                "line": line_num,
                "snippet": line.strip()[:160],
                "figure_id": None,
            })
    return matches


def _check_failed_figure_references(
    draft_text: str, draft_file: str, generate_images_status: Path
) -> tuple[list[dict], list[str]]:
    """If `_status/generate_images.json` lists failed figure_ids, find any
    reference to them in `draft_text` (`\\input{...figures/<id>}` or
    `\\ref{fig:<id>}`)."""
    if not generate_images_status.exists():
        return [], []
    try:
        status = json.loads(generate_images_status.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return [], []
    failed_ids = [
        f.get("figure_id") for f in status.get("failed", []) or []
        if isinstance(f, dict) and f.get("figure_id")
    ]
    if not failed_ids:
        return [], []

    issues: list[dict] = []
    referenced: list[str] = []
    for fid in failed_ids:
        # \input{...figures/F1.tex} or \input{...figures/F1}
        rx_input = re.compile(
            r"\\input\s*\{[^}]*figures/" + re.escape(fid) + r"(?:\.tex)?\s*\}"
        )
        rx_ref = re.compile(
            r"\\(?:ref|cref|autoref|eqref)\s*\{fig:" + re.escape(fid) + r"\}"
        )
        hit_for_id = False
        for line_num, line in enumerate(draft_text.splitlines(), 1):
            if rx_input.search(line) or rx_ref.search(line):
                issues.append({
                    "kind": "image_generation_failed_referenced",
                    "file": draft_file,
                    "line": line_num,
                    "snippet": line.strip()[:160],
                    "figure_id": fid,
                })
                hit_for_id = True
        if hit_for_id:
            referenced.append(fid)
    return issues, referenced


def _check_unescaped_percent(text: str, source_file: str) -> list[dict]:
    """Find `%` characters in body text that are not escaped, not in a
    verbatim region, and not on a whole-line comment. Reports every
    occurrence (not just the first per line) so the count is accurate."""
    masked = _mask_verbatim(text)
    original_lines = text.splitlines()
    matches: list[dict] = []
    for line_num, line in enumerate(masked.splitlines(), 1):
        if _RE_FULL_LINE_COMMENT.match(line):
            continue
        original_line = original_lines[line_num - 1] if line_num - 1 < len(original_lines) else line
        for m in _RE_UNESCAPED_PERCENT.finditer(line):
            col = m.start()
            start = max(col - 30, 0)
            end = min(col + 30, len(original_line))
            snippet = original_line[start:end].strip()
            matches.append({
                "kind": "unescaped_percent",
                "file": source_file,
                "line": line_num,
                "column": col + 1,
                "snippet": snippet[:160],
            })
    return matches


# ---------------------------------------------------------------------------
# Table-overflow detector (kinds: table_overflow_long_token,
# table_overflow_long_cell, table_column_count_mismatch,
# table_fixed_width_overflow_page, table_wide_no_width_control)
# ---------------------------------------------------------------------------

# TeX-point conversions. 1 in = 72.27 pt; 1 cm = 28.45274 pt.
_PT_PER_CM = 28.45274
_PT_PER_MM = 2.845274
_PT_PER_IN = 72.27
_PT_PER_PC = 12.0
_PT_PER_BP = 1.00375

# A4 with `\geometry{margin=2.4cm}` (this project's preamble) leaves
# textwidth ≈ 21cm − 2*2.4cm = 16.2cm ≈ 461pt. Used as the fallback when a
# tabularx uses `\linewidth` / `\textwidth` without us knowing the exact
# document setup. Conservative — if the actual textwidth is smaller, our
# estimate undershoots and we'd miss some real overflows but produce no
# false positives.
_DEFAULT_TEXT_WIDTH_PT = 461.0
# Default body font (ctexart [11pt] in this project; falls back gracefully
# if the doc uses 10pt or 12pt — we're only after order-of-magnitude width).
_DEFAULT_BASE_FONT_PT = 11.0
# Default `\tabcolsep` is 6pt either side of each column. Padding per column
# is therefore ~12pt; padding for an N-column table is ~12*N pt of fixed cost.
_DEFAULT_TABCOLSEP_PT = 6.0
# Average Latin char width at the body font size, calibrated for the
# "uppercase + digits + symbol" mix that triggers real overflows (e.g.
# `HR+13/MRR+24/NDCG+20%`). Slightly under the visual measurement of CMR/LMR
# to stay conservative against false positives on prose-style cells.
_LATIN_AVG_PER_PT = 0.50
# Per-cell overflow tolerance. The width estimator overestimates lowercase-
# heavy tokens by ~10-15% (calibration above is biased for uppercase/digit
# mix); `\raggedright` columns also forgive small overruns without column
# overlap. Tolerate the larger of 6pt (~ one body-font char) or 8% of the
# column. Anything beyond that genuinely overlaps the next column.
_OVERFLOW_TOLERANCE_PT = 6.0
_OVERFLOW_TOLERANCE_FRAC = 0.08


def _overflow_budget(cw_pt: float) -> float:
    return cw_pt + max(_OVERFLOW_TOLERANCE_PT, _OVERFLOW_TOLERANCE_FRAC * cw_pt)
# CJK char width at the body font size — full-width by convention.
_CJK_AVG_PER_PT = 1.0
# Multiplicative font-size factors keyed by command name.
_FONT_SIZE_FACTORS: dict[str, float] = {
    "tiny": 0.55,
    "scriptsize": 0.70,
    "footnotesize": 0.83,
    "small": 0.91,
    "normalsize": 1.0,
    "large": 1.20,
    "Large": 1.44,
    "LARGE": 1.73,
    "huge": 2.07,
    "Huge": 2.49,
}

# Regex matching one length-with-unit token (e.g. "2.5cm", "0.4\linewidth",
# "120pt"). Anchored fullmatch in `_parse_length_pt`.
_RE_LENGTH = re.compile(
    r"\s*([+-]?\d*\.?\d+)\s*"
    r"(cm|mm|in|pt|pc|bp|em|ex|\\linewidth|\\textwidth|\\columnwidth|\\hsize)\s*"
)
# Table environments we parse. `tabular*` and `xltabular`/`tabularx` take a
# leading width arg; `longtabu` is rare and parsed best-effort.
_TABLE_ENV_NAMES = (
    "tabular", r"tabular\*", "tabularx", "xltabular", "longtable", "longtabu"
)
_RE_TABLE_BLOCK = re.compile(
    r"\\begin\{(" + "|".join(_TABLE_ENV_NAMES) + r")\}"
    r"([\s\S]*?)"
    r"\\end\{\1\}",
)
# Commands that introduce a column-by-column scaling wrapper around a tabular.
_RE_WIDTH_WRAPPER = re.compile(
    r"\\(?:resizebox|scalebox|adjustbox|includegraphics)\b"
)
# Standalone font-size commands that apply to the rest of their group.
_RE_FONT_SIZE_CMD = re.compile(
    r"\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b"
)
# `\setlength{\tabcolsep}{<len>}` capture.
_RE_TABCOLSEP = re.compile(
    r"\\setlength\s*\{\s*\\tabcolsep\s*\}\s*\{([^{}]+)\}"
)


def _parse_length_pt(
    s: str,
    base_font_pt: float = _DEFAULT_BASE_FONT_PT,
    total_width_pt: float = _DEFAULT_TEXT_WIDTH_PT,
) -> float | None:
    """Parse a LaTeX length expression (e.g. `2.5cm`, `0.4\\linewidth`,
    `120pt`, `\\linewidth`) into TeX points. Returns None if the
    expression is unparseable (e.g. contains a command we don't
    understand)."""
    if not s:
        return None
    s = s.strip()
    # Bare width-reference commands without a numeric coefficient → 1×ref.
    if s in (r"\linewidth", r"\textwidth", r"\columnwidth", r"\hsize"):
        return total_width_pt
    m = _RE_LENGTH.fullmatch(s)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2)
    if unit == "cm":
        return val * _PT_PER_CM
    if unit == "mm":
        return val * _PT_PER_MM
    if unit == "in":
        return val * _PT_PER_IN
    if unit == "pt":
        return val
    if unit == "pc":
        return val * _PT_PER_PC
    if unit == "bp":
        return val * _PT_PER_BP
    if unit == "em":
        return val * base_font_pt
    if unit == "ex":
        return val * base_font_pt * 0.5
    if unit in (r"\linewidth", r"\textwidth", r"\columnwidth", r"\hsize"):
        return val * total_width_pt
    return None


def _matching_brace(s: str, open_idx: int) -> int:
    """Given s[open_idx] == '{', return the index of the matching '}'.
    Returns -1 if no balanced match is found."""
    if open_idx >= len(s) or s[open_idx] != "{":
        return -1
    depth = 0
    for k in range(open_idx, len(s)):
        c = s[k]
        if c == "\\" and k + 1 < len(s):
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return k
    return -1


def _tokenize_colspec(spec: str) -> list[dict]:
    """Tokenize a tabular column specification into a flat list of column
    dicts: {'type': 'l'|'c'|'r'|'p'|'m'|'b'|'X', 'width_raw': str|None,
    'raw': str}. Strips `|`, `>{...}`, `<{...}`, `@{...}`, `!{...}`, and
    expands `*{N}{sub}` repetitions."""
    cols: list[dict] = []
    i = 0
    n = len(spec)
    while i < n:
        ch = spec[i]
        if ch in "| \t\n\r":
            i += 1
            continue
        # @{...}, !{...}, >{...}, <{...} — skip the brace group entirely.
        if ch in "@!><" and i + 1 < n and spec[i + 1] == "{":
            j = _matching_brace(spec, i + 1)
            i = j + 1 if j > 0 else i + 1
            continue
        # *{N}{sub-spec} — expand sub-spec N times.
        if ch == "*" and i + 1 < n and spec[i + 1] == "{":
            j = _matching_brace(spec, i + 1)
            if j <= 0:
                i += 1
                continue
            try:
                repeat = int(spec[i + 2:j].strip())
            except ValueError:
                i = j + 1
                continue
            if j + 1 < n and spec[j + 1] == "{":
                k = _matching_brace(spec, j + 1)
                if k <= 0:
                    i = j + 1
                    continue
                sub_cols = _tokenize_colspec(spec[j + 2:k])
                for _ in range(repeat):
                    cols.extend(sub_cols)
                i = k + 1
            else:
                i = j + 1
            continue
        # l / c / r — natural-width columns.
        if ch in "lcr":
            cols.append({"type": ch, "width_raw": None, "raw": ch})
            i += 1
            continue
        # X — tabularx elastic column (width derived after parsing).
        if ch == "X":
            cols.append({"type": "X", "width_raw": None, "raw": "X"})
            i += 1
            continue
        # p / m / b followed by {width}.
        if ch in "pmb" and i + 1 < n and spec[i + 1] == "{":
            j = _matching_brace(spec, i + 1)
            if j > 0:
                width = spec[i + 2:j].strip()
                cols.append({"type": ch, "width_raw": width,
                             "raw": spec[i:j + 1]})
                i = j + 1
                continue
        # Unknown char (e.g. a custom array.sty type) — skip silently to
        # avoid infinite loops; do not append a column for it.
        i += 1
    return cols


def _strip_latex_markup(s: str) -> str:
    """Approximate the rendered text of a cell by stripping common LaTeX
    markup. Errs on the side of preserving content so token widths are
    overestimated, not under. Citations collapse to `[REF]` so they don't
    look like long unbreakable identifiers."""
    # `\%`, `\&`, `\$`, `\#`, `\_` → the literal symbol.
    s = re.sub(r"\\([%&$#_])", r"\1", s)
    # Citation / ref family → [REF] (short, breakable enough).
    s = re.sub(
        r"\\(?:cite[a-z]*|citet|citep|citealp|citealt|citeauthor|citeyear|"
        r"nocite|ref|autoref|eqref|cref|Cref|pageref)\s*"
        r"(?:\[[^\]]*\])?\s*\{[^{}]*\}",
        "[REF]", s,
    )
    # Text-styling: \textbf{X} / \textit{X} / \emph{X} / etc. → X.
    s = re.sub(
        r"\\(?:textbf|textit|textsl|textsc|textsf|texttt|textrm|emph|"
        r"underline)\s*\{([^{}]*)\}",
        r"\1", s,
    )
    # Inline math `$...$` → keep inner chars.
    s = re.sub(r"\$([^$]*)\$", r"\1", s)
    # Strip remaining commands like \toprule, \midrule, \hline, \rowcolor{...},
    # \multirow{n}{w}{x}, \cmidrule, etc., along with any optional [] args and
    # `{}` arg groups attached.
    s = re.sub(
        r"\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\})*",
        "", s,
    )
    # Collapse remaining `{...}` groups to their contents.
    s = re.sub(r"\{([^{}]*)\}", r"\1", s)
    return s


def _estimate_text_width_pt(rendered: str, font_pt: float) -> float:
    """Estimate the rendered width in TeX points of a text token. CJK chars
    contribute full-width, everything else contributes Latin average."""
    width = 0.0
    for ch in rendered:
        code = ord(ch)
        # CJK Unified Ideographs + CJK Symbols and Punctuation + Hiragana/
        # Katakana + Hangul Syllables + Fullwidth Forms.
        if (
            0x3000 <= code <= 0x303F
            or 0x3040 <= code <= 0x30FF
            or 0x3400 <= code <= 0x4DBF
            or 0x4E00 <= code <= 0x9FFF
            or 0xAC00 <= code <= 0xD7AF
            or 0xFF00 <= code <= 0xFFEF
        ):
            width += _CJK_AVG_PER_PT * font_pt
        elif ch.isspace():
            width += _LATIN_AVG_PER_PT * font_pt * 0.5
        else:
            width += _LATIN_AVG_PER_PT * font_pt
    return width


# Characters where LaTeX will happily allow a line break (default behaviour
# of the typesetter for unhyphenated text). `-`, `–`, `—` introduce explicit
# break points; ASCII whitespace and CJK punctuation likewise.
_BREAKABLE_CHARS = set(" \t\n\r-‐‑‒–—"
                       "，。、；：？！…）」》】〕、。、")


def _is_cjk(ch: str) -> bool:
    """Return True if `ch` is a CJK ideograph / kana / hangul / fullwidth
    char. ctex / xeCJK inserts breakable glue between every pair of these
    so they cannot form an unbreakable run on their own."""
    code = ord(ch)
    return (
        0x3000 <= code <= 0x303F
        or 0x3040 <= code <= 0x30FF
        or 0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xAC00 <= code <= 0xD7AF
        or 0xFF00 <= code <= 0xFFEF
    )


def _longest_unbreakable_token(rendered: str) -> str:
    """Return the longest contiguous run of non-breakable characters in
    `rendered`. `/`, `+`, `_`, `.`, `%`, digits, latin letters all count
    as unbreakable. CJK characters break between each other (xeCJK glue),
    so each CJK char terminates the current Latin run and counts only as
    a 1-char token on its own."""
    longest = ""
    cur: list[str] = []
    for ch in rendered:
        if ch in _BREAKABLE_CHARS:
            if cur:
                run = "".join(cur)
                if len(run) > len(longest):
                    longest = run
                cur = []
            continue
        if _is_cjk(ch):
            if cur:
                run = "".join(cur)
                if len(run) > len(longest):
                    longest = run
                cur = []
            # The CJK char itself is a 1-char "token" — usually trivially
            # narrower than any column, but kept here so a microscopic
            # column (< 1em) would still see something.
            if len(longest) < 1:
                longest = ch
            continue
        cur.append(ch)
    if cur:
        run = "".join(cur)
        if len(run) > len(longest):
            longest = run
    return longest


def _font_factor_in_context(preceding: str) -> float:
    """Return the multiplicative font-size factor applied to the table by
    the nearest preceding `\\small`/`\\footnotesize`/... command. Defaults
    to 1.0 (normalsize) if none is found."""
    matches = list(_RE_FONT_SIZE_CMD.finditer(preceding))
    if not matches:
        return 1.0
    return _FONT_SIZE_FACTORS.get(matches[-1].group(1), 1.0)


def _tabcolsep_in_context(preceding: str) -> float:
    """Return the most recent explicit `\\tabcolsep` length in `preceding`,
    in TeX points. Falls back to the LaTeX default 6pt."""
    matches = list(_RE_TABCOLSEP.finditer(preceding))
    if not matches:
        return _DEFAULT_TABCOLSEP_PT
    val = _parse_length_pt(matches[-1].group(1).strip())
    if val is None:
        return _DEFAULT_TABCOLSEP_PT
    return val


def _split_row_cells(row_body: str) -> list[str]:
    """Split a tabular row on un-escaped `&`. Skips `\\&` (literal ampersand)
    and `\\\\` (row terminator already removed by caller)."""
    cells: list[str] = []
    cur: list[str] = []
    i = 0
    n = len(row_body)
    while i < n:
        ch = row_body[i]
        if ch == "\\" and i + 1 < n:
            cur.append(row_body[i:i + 2])
            i += 2
            continue
        if ch == "&":
            cells.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    cells.append("".join(cur))
    return cells


def _split_rows(body: str) -> list[tuple[str, int]]:
    """Split a tabular body into (row_text, terminator_offset) pairs. The
    terminator offset is the index of the `\\\\` (or end of body for the
    final unterminated row) — we report this rather than the row's start
    so reported source line numbers point at the row a reader sees in the
    editor (`\\\\` is the end-of-row marker; the cells precede it).
    Row terminator is `\\\\` (optionally with `*`, optionally followed by
    `[len]` for inter-row spacing). `\\hline` / `\\midrule` / `\\toprule`
    / `\\bottomrule` / `\\cmidrule[...]{...}` / `\\addlinespace[...]` are
    filtered out as structural-only rows."""
    rows: list[tuple[str, int]] = []
    cur_start = 0
    i = 0
    n = len(body)
    while i < n:
        if body[i] == "\\" and i + 1 < n and body[i + 1] == "\\":
            row_text = body[cur_start:i]
            term_off = i  # index of the `\\` terminator
            rows.append((row_text, term_off))
            i += 2
            # Optional `*` (prevents page break).
            if i < n and body[i] == "*":
                i += 1
            # Skip optional `[length]` after `\\`.
            while i < n and body[i] in " \t":
                i += 1
            if i < n and body[i] == "[":
                end = body.find("]", i)
                if end > 0:
                    i = end + 1
            cur_start = i
            continue
        i += 1
    if cur_start < n:
        tail = body[cur_start:]
        if tail.strip():
            rows.append((tail, n))
    # Filter rows that contain only structural rules (no `&`, no real
    # cell text). A row is structural if, after stripping LaTeX markup,
    # it has no printable content.
    out: list[tuple[str, int]] = []
    for row_text, off in rows:
        stripped = _strip_latex_markup(row_text).strip()
        if not stripped and "&" not in row_text:
            continue
        out.append((row_text, off))
    return out


def _extract_multicolumn_inner_spec(cell: str) -> str | None:
    """For a cell of the form `\\multicolumn{n}{<spec>}{<content>}`,
    extract `<spec>` so the per-cell width check can use the multicolumn's
    own declared column type instead of the underlying tabular's col.
    Returns None if the cell isn't a well-formed multicolumn or the spec
    can't be located."""
    m = re.match(r"\s*\\multicolumn\s*", cell)
    if not m:
        return None
    i = m.end()
    if i >= len(cell) or cell[i] != "{":
        return None
    j = _matching_brace(cell, i)
    if j < 0:
        return None
    i = j + 1
    while i < len(cell) and cell[i] in " \t\n\r":
        i += 1
    if i >= len(cell) or cell[i] != "{":
        return None
    j = _matching_brace(cell, i)
    if j < 0:
        return None
    return cell[i + 1:j]


def _count_logical_columns(cells: list[str]) -> int:
    """Account for `\\multicolumn{n}{spec}{content}` by treating it as
    occupying `n` columns. Returns the logical column count of the row."""
    total = 0
    rx = re.compile(r"\\multicolumn\s*\{\s*(\d+)\s*\}")
    for cell in cells:
        m = rx.search(cell)
        if m:
            try:
                total += int(m.group(1))
            except ValueError:
                total += 1
        else:
            total += 1
    return total


def _parse_table_header(env: str, after_begin: str) -> tuple[
    str | None, str | None, int,
]:
    """For a table-env body starting right after `\\begin{<env>}`, parse:
      - optional `[pos]` (skipped),
      - for `tabular*` / `tabularx` / `xltabular`: leading `{<width>}`,
      - the column-spec `{<spec>}`.
    Returns (total_width_raw, colspec_raw, consumed_chars). If parsing
    fails, returns (None, None, 0)."""
    i = 0
    n = len(after_begin)
    # Optional [pos] for tabular / longtable.
    while i < n and after_begin[i] in " \t\n\r":
        i += 1
    if i < n and after_begin[i] == "[":
        end = after_begin.find("]", i)
        if end > 0:
            i = end + 1
    while i < n and after_begin[i] in " \t\n\r":
        i += 1
    total_width_raw: str | None = None
    needs_width = env in ("tabular*", "tabularx", "xltabular", "longtabu")
    if needs_width:
        if i >= n or after_begin[i] != "{":
            return None, None, 0
        j = _matching_brace(after_begin, i)
        if j <= 0:
            return None, None, 0
        total_width_raw = after_begin[i + 1:j].strip()
        i = j + 1
        while i < n and after_begin[i] in " \t\n\r":
            i += 1
        # For `tabular*`, an optional `@{...}` may precede the colspec.
        if i < n and after_begin[i] == "@":
            if i + 1 < n and after_begin[i + 1] == "{":
                k = _matching_brace(after_begin, i + 1)
                if k > 0:
                    i = k + 1
                    while i < n and after_begin[i] in " \t\n\r":
                        i += 1
    if i >= n or after_begin[i] != "{":
        return None, None, 0
    j = _matching_brace(after_begin, i)
    if j <= 0:
        return None, None, 0
    colspec_raw = after_begin[i + 1:j]
    return total_width_raw, colspec_raw, j + 1


def _resolve_column_widths_pt(
    cols: list[dict],
    total_width_pt: float | None,
    tabcolsep_pt: float,
    font_factor: float,
    base_font_pt: float,
) -> list[float | None]:
    """Compute per-column rendered width in pt. Fixed-width p/m/b are
    parsed directly. `X` columns share the residual after subtracting
    fixed widths and per-column padding. `l/c/r` columns have no
    width budget — we mark them as None (caller treats None as
    "unbounded → cannot overflow the rendered width" for R1/R2,
    but R5 still flags many-l/c/r tables with long content)."""
    widths: list[float | None] = [None] * len(cols)
    fixed_sum_pt = 0.0
    x_indices: list[int] = []
    natural_indices: list[int] = []
    for idx, col in enumerate(cols):
        if col["type"] in ("p", "m", "b") and col["width_raw"]:
            w = _parse_length_pt(col["width_raw"], base_font_pt,
                                 total_width_pt or _DEFAULT_TEXT_WIDTH_PT)
            if w is not None:
                widths[idx] = w
                fixed_sum_pt += w
        elif col["type"] == "X":
            x_indices.append(idx)
        else:
            natural_indices.append(idx)
    if x_indices and total_width_pt is not None:
        padding_total = tabcolsep_pt * 2 * len(cols)
        # Reserve ~30pt per natural-width l/c/r column for content
        # (rough, but we only need this to compute the X share).
        natural_reserve = 30.0 * len(natural_indices)
        residual = total_width_pt - fixed_sum_pt - padding_total - natural_reserve
        per_x = residual / len(x_indices) if residual > 0 else 0.0
        for idx in x_indices:
            widths[idx] = max(per_x, 0.0)
    return widths


def _check_table_overflow(text: str, source_file: str) -> list[dict]:
    """Find tabular/tabularx/longtable environments whose content is
    likely to overflow the declared column widths. See module docstring
    for the five sub-kinds emitted."""
    issues: list[dict] = []
    # Pre-mask verbatim regions so we don't parse example LaTeX as real.
    masked = _mask_verbatim(text)
    for m in _RE_TABLE_BLOCK.finditer(masked):
        env = m.group(1)
        block_start = m.start()
        env_start_line = text[:block_start].count("\n") + 1
        body_after_begin_idx = m.start() + len(f"\\begin{{{env}}}")
        after_begin = masked[body_after_begin_idx:m.end() -
                              len(f"\\end{{{env}}}")]
        total_width_raw, colspec_raw, consumed = _parse_table_header(
            env, after_begin
        )
        if colspec_raw is None:
            continue
        cols = _tokenize_colspec(colspec_raw)
        if not cols:
            continue
        body = after_begin[consumed:]
        body_start_in_text = body_after_begin_idx + consumed
        preceding = text[max(0, block_start - 800):block_start]
        font_factor = _font_factor_in_context(preceding)
        tabcolsep_pt = _tabcolsep_in_context(preceding)
        base_font_pt = _DEFAULT_BASE_FONT_PT
        font_pt = base_font_pt * font_factor
        total_width_pt: float | None = None
        if total_width_raw:
            total_width_pt = _parse_length_pt(
                total_width_raw, base_font_pt, _DEFAULT_TEXT_WIDTH_PT
            )
        elif env in ("longtable",):
            total_width_pt = _DEFAULT_TEXT_WIDTH_PT
        col_widths_pt = _resolve_column_widths_pt(
            cols, total_width_pt, tabcolsep_pt, font_factor, base_font_pt
        )
        n_cols = len(cols)
        # R4: fixed-width sum vs page width — only meaningful for plain
        # `tabular` (tabularx fits to total_width by design).
        if env in ("tabular", "tabular*"):
            fixed_sum_pt = sum(
                w for w, col in zip(col_widths_pt, cols)
                if w is not None and col["type"] in ("p", "m", "b")
            )
            if fixed_sum_pt > _DEFAULT_TEXT_WIDTH_PT + 28.0:
                issues.append({
                    "kind": "table_fixed_width_overflow_page",
                    "file": source_file,
                    "line": env_start_line,
                    "snippet": colspec_raw[:160],
                    "table_env": env,
                    "column_index": None,
                    "column_spec_token": colspec_raw[:80],
                    "estimated_token_width_pt": round(fixed_sum_pt, 2),
                    "estimated_column_width_pt": round(_DEFAULT_TEXT_WIDTH_PT, 2),
                    "overflow_pt": round(fixed_sum_pt - _DEFAULT_TEXT_WIDTH_PT, 2),
                })
        # R4 variant for tabularx / xltabular: if the fixed columns + padding
        # have eaten the table's total width, every X column is squeezed to
        # ≤ 0.5 cm and any content inside it WILL overflow. Emit one
        # structural issue per table and skip per-X-cell R1/R2 (otherwise
        # we'd report every cell of the X column individually).
        starved_x_cols: set[int] = set()
        if env in ("tabularx", "xltabular") and total_width_pt is not None:
            x_indices = [i for i, c in enumerate(cols) if c["type"] == "X"]
            if x_indices:
                starved = [
                    i for i in x_indices
                    if col_widths_pt[i] is not None
                    and col_widths_pt[i] < 0.5 * _PT_PER_CM
                ]
                if starved == x_indices:
                    fixed_sum_pt = sum(
                        w for w, col in zip(col_widths_pt, cols)
                        if w is not None and col["type"] in ("p", "m", "b")
                    )
                    issues.append({
                        "kind": "table_fixed_width_overflow_page",
                        "file": source_file,
                        "line": env_start_line,
                        "snippet": colspec_raw[:160],
                        "table_env": env,
                        "column_index": None,
                        "column_spec_token": colspec_raw[:80],
                        "estimated_token_width_pt": round(fixed_sum_pt, 2),
                        "estimated_column_width_pt": round(total_width_pt, 2),
                        "overflow_pt": round(
                            fixed_sum_pt - total_width_pt, 2
                        ),
                    })
                    starved_x_cols = set(starved)
        # R5: many-column l/c/r table with long content and no scaling
        # wrapper. Look 1000 chars back for `\resizebox`/`\scalebox`/
        # `\adjustbox`.
        wrap_window = text[max(0, block_start - 1000):block_start]
        has_wrapper = bool(_RE_WIDTH_WRAPPER.search(wrap_window))
        natural_cols = [c for c in cols if c["type"] in ("l", "c", "r")]
        rows = _split_rows(body)
        r5_emitted = False
        if (
            len(cols) >= 4
            and len(natural_cols) == len(cols)
            and not has_wrapper
            and font_factor >= 1.0
        ):
            for row_text, row_off in rows:
                cells = _split_row_cells(row_text)
                for cell_idx, cell in enumerate(cells):
                    rendered = _strip_latex_markup(cell).strip()
                    cjk_len = sum(
                        1 for c in rendered
                        if ord(c) >= 0x3000 and ord(c) <= 0xFFEF
                    )
                    latin_len = len(rendered) - cjk_len
                    if cjk_len >= 15 or latin_len >= 30:
                        line_no = (
                            env_start_line
                            + text[body_start_in_text:
                                   body_start_in_text + row_off].count("\n")
                        )
                        issues.append({
                            "kind": "table_wide_no_width_control",
                            "file": source_file,
                            "line": line_no,
                            "snippet": rendered[:160],
                            "table_env": env,
                            "column_index": cell_idx + 1,
                            "column_spec_token": colspec_raw[:80],
                        })
                        r5_emitted = True
                        break
                if r5_emitted:
                    break
        # R1 / R2 / R3 per-cell sweep.
        for row_text, row_off in rows:
            cells = _split_row_cells(row_text)
            line_no = (
                env_start_line
                + text[body_start_in_text:
                       body_start_in_text + row_off].count("\n")
            )
            logical = _count_logical_columns(cells)
            if logical != n_cols:
                issues.append({
                    "kind": "table_column_count_mismatch",
                    "file": source_file,
                    "line": line_no,
                    "snippet": _strip_latex_markup(row_text).strip()[:160],
                    "table_env": env,
                    "column_index": logical,
                    "column_spec_token": colspec_raw[:80],
                })
                continue
            col_cursor = 0
            for cell in cells:
                rx_mc = re.match(
                    r"\s*\\multicolumn\s*\{\s*(\d+)\s*\}",
                    cell,
                )
                span = 1
                if rx_mc:
                    try:
                        span = int(rx_mc.group(1))
                    except ValueError:
                        span = 1
                if col_cursor >= n_cols:
                    break
                col = cols[col_cursor]
                cw = col_widths_pt[col_cursor]
                # If this cell is a `\multicolumn{n}{spec}{content}`, the
                # spec OVERRIDES the underlying col's spec. Parse the
                # inner spec and use its width — `\multicolumn{3}{p{1cm}}`
                # should be checked against 1cm, not 3 × underlying col.
                mc_col: dict | None = None
                if rx_mc:
                    mc_inner = _extract_multicolumn_inner_spec(cell)
                    if mc_inner is not None:
                        mc_cols = _tokenize_colspec(mc_inner)
                        if mc_cols:
                            mc_col = mc_cols[0]
                            if mc_col["type"] in ("p", "m", "b") and mc_col["width_raw"]:
                                mc_w = _parse_length_pt(
                                    mc_col["width_raw"], base_font_pt,
                                    total_width_pt or _DEFAULT_TEXT_WIDTH_PT,
                                )
                                if mc_w is not None:
                                    col = mc_col
                                    cw = mc_w
                                    # multicolumn declared its own width,
                                    # span no longer multiplies it.
                                    span = 1
                if (
                    col["type"] in ("p", "m", "b", "X")
                    and cw is not None
                    and cw > 0
                    and col_cursor not in starved_x_cols
                ):
                    rendered = _strip_latex_markup(cell).strip()
                    if rendered:
                        # R1: longest unbreakable token vs column width.
                        # Uses _overflow_budget() so calibration noise
                        # (≈10-15% on lowercase-heavy tokens) doesn't
                        # trip the gate.
                        token = _longest_unbreakable_token(rendered)
                        token_pt = _estimate_text_width_pt(token, font_pt)
                        # Multi-col span gets `span` × column width plus
                        # `(span-1)` internal padding.
                        effective_cw = cw * span + 2 * tabcolsep_pt * (span - 1)
                        if token_pt > _overflow_budget(effective_cw):
                            issues.append({
                                "kind": "table_overflow_long_token",
                                "file": source_file,
                                "line": line_no,
                                "snippet": rendered[:160],
                                "table_env": env,
                                "column_index": col_cursor + 1,
                                "column_spec_token": col["raw"],
                                "estimated_token_width_pt": round(token_pt, 2),
                                "estimated_column_width_pt": round(effective_cw, 2),
                                "overflow_pt": round(token_pt - effective_cw, 2),
                            })
                # R1 variant for c/l/r columns in tabularx-style envs that
                # have a fixed total width: a natural-width column will
                # expand to fit its longest token; if that token alone
                # exceeds the table's total minus all fixed cols + a
                # minimum reservation for the other natural/X cols, the
                # whole table will overflow the page. (Plain `tabular` has
                # no total budget so c/l/r naturally just extend the table
                # right; that's caught by R5 instead.)
                elif (
                    env in ("tabularx", "xltabular")
                    and col["type"] in ("l", "c", "r")
                    and total_width_pt is not None
                ):
                    rendered = _strip_latex_markup(cell).strip()
                    if rendered:
                        token = _longest_unbreakable_token(rendered)
                        token_pt = _estimate_text_width_pt(token, font_pt)
                        padding_total = tabcolsep_pt * 2 * len(cols)
                        fixed_sum = sum(
                            w for w, c in zip(col_widths_pt, cols)
                            if w is not None and c["type"] in ("p", "m", "b")
                        )
                        other_count = sum(
                            1 for j, c in enumerate(cols)
                            if j != col_cursor
                            and c["type"] in ("l", "c", "r", "X")
                        )
                        min_reserve_pt = 14.0  # ~0.5cm per other col
                        available = (
                            total_width_pt - fixed_sum - padding_total
                            - other_count * min_reserve_pt
                        )
                        if token_pt > _overflow_budget(available):
                            issues.append({
                                "kind": "table_overflow_long_token",
                                "file": source_file,
                                "line": line_no,
                                "snippet": rendered[:160],
                                "table_env": env,
                                "column_index": col_cursor + 1,
                                "column_spec_token": col["raw"],
                                "estimated_token_width_pt": round(token_pt, 2),
                                "estimated_column_width_pt": round(available, 2),
                                "overflow_pt": round(token_pt - available, 2),
                            })
                col_cursor += span
    return issues


def _resolve_draft(workspace: Path) -> tuple[str, str] | tuple[None, None]:
    """Return (relpath, text) for the draft under audit, mirroring
    workspace_io.WorkspaceIO.read_draft. Returns (None, None) if no draft
    is found (caller decides whether to SKIP or fail)."""
    candidates: list[tuple[Path, str]] = [
        (workspace / "06_output" / "survey.tex", "06_output/survey.tex"),
    ]
    gen = workspace / "05_generation"
    if gen.is_dir():
        for name in ("full_draft.tex", "full_draft.md", "full_draft.txt"):
            candidates.append((gen / name, f"05_generation/{name}"))
    for p, relpath in candidates:
        if p.exists():
            try:
                return relpath, p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
    return None, None


def audit(workspace: Path) -> dict:
    """Run all latex_safety checks on the workspace.

    Returns a payload with `passed`, per-kind counts, `failed_figures_referenced`,
    and a flat `matches[]` list. Schema mirrors other fast-audit modules so
    aggregator/merger can consume it uniformly.
    """
    workspace = Path(workspace)
    draft_relpath, draft_text = _resolve_draft(workspace)

    matches: list[dict] = []
    image_placeholder_count = 0
    unescaped_percent_count = 0
    failed_figures_referenced: list[str] = []
    table_overflow_count = 0

    # 1. Scan figure subfiles under 05_generation/figures/ — these are the
    #    most common carriers of literal "Figure placeholder for F1." text.
    figures_dir = workspace / "05_generation" / "figures"
    if figures_dir.is_dir():
        for fp in sorted(figures_dir.glob("*.tex")):
            try:
                fig_text = fp.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = f"05_generation/figures/{fp.name}"
            hits = _check_image_placeholders(fig_text, rel)
            matches.extend(hits)
            image_placeholder_count += len(hits)

    # 2. Scan main draft for placeholder text + unescaped percent + references
    #    to figures whose generation failed upstream + inline tables.
    if draft_text is not None and draft_relpath is not None:
        # 2a. Placeholder text inlined directly in the draft (rare but possible).
        hits = _check_image_placeholders(draft_text, draft_relpath)
        matches.extend(hits)
        image_placeholder_count += len(hits)

        # 2b. Unescaped percent signs.
        hits = _check_unescaped_percent(draft_text, draft_relpath)
        matches.extend(hits)
        unescaped_percent_count += len(hits)

        # 2c. References to failed figures.
        status_path = workspace / "05_generation" / "_status" / "generate_images.json"
        ref_issues, ref_ids = _check_failed_figure_references(
            draft_text, draft_relpath, status_path
        )
        matches.extend(ref_issues)
        failed_figures_referenced = ref_ids

        # 2d. Inline table overflow checks (rare — most tables are subfiles).
        hits = _check_table_overflow(draft_text, draft_relpath)
        matches.extend(hits)
        table_overflow_count += len(hits)

    # 3. Scan table subfiles under {05_generation,06_output}/tables/ — the
    #    common pattern is `\input{tables/T<n>.tex}` from the main draft.
    seen_tables: set[str] = set()
    for sub in ("06_output/tables", "05_generation/tables"):
        tables_dir = workspace / sub
        if not tables_dir.is_dir():
            continue
        for fp in sorted(tables_dir.glob("*.tex")):
            if fp.name in seen_tables:
                continue
            seen_tables.add(fp.name)
            try:
                tbl_text = fp.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = f"{sub}/{fp.name}"
            hits = _check_table_overflow(tbl_text, rel)
            matches.extend(hits)
            table_overflow_count += len(hits)

    passed = (
        image_placeholder_count == 0
        and unescaped_percent_count == 0
        and not failed_figures_referenced
        and table_overflow_count == 0
    )
    return {
        "passed": passed,
        "image_placeholder_count": image_placeholder_count,
        "unescaped_percent_count": unescaped_percent_count,
        "failed_figures_referenced": failed_figures_referenced,
        "table_overflow_count": table_overflow_count,
        "draft_file": draft_relpath,
        "matches": matches,
    }
