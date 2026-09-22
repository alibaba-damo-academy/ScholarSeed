"""Compatibility table-shape checks and shared helpers.

Explicit validate_tables callers may use collect_problems. These checks are not
additional gates on current chapter_delta manuscript responses."""
from __future__ import annotations

import re
from figure_caption import has_numbering_prefix


# ============================================================================
# Constants — the ONLY place these live.
# ============================================================================

# Explicit p{...cm} width budgets per layout shell.
P_BUDGET_TABULARX = 9.0
P_BUDGET_RESIZEBOX = 12.0
# Per-cell verbosity caps, applied after stripping \cite{...}. The width cap is
# a DISPLAY width (CJK counts as 2) so it matches the prompt's "≤ 50 渲染字符
# (中文 ≈ 20–25 汉字)" hard cap for both languages with one number.
CELL_WIDTH_CAP = 50
CELL_WORD_CAP = 10
# Column-count window (prompt rule 6: "4–6 columns total").
COL_MIN = 2
COL_MAX = 6
# An unbroken ASCII run this long in a cell overlaps its neighbour (non-wrapping
# column) or inflates an X column into a blank stripe.
LONG_TOKEN_LEN = 20
# A non-identity column whose value is identical across at least this many rows
# carries no comparative information and wastes width.
UNIFORM_MIN_ROWS = 3
# A fixed p{Wcm} text column at or below this width is "narrow" — prone to wrap
# CJK / multi-word content when a greedy X column hoards the leftover slack.
NARROW_P_CM = 2.6
# Approximate \linewidth (cm) under ctex A4 with 2.4 cm margins. A non-wrapping
# tabular* whose estimated natural row width exceeds this overflows the page,
# because l/c/r cells cannot wrap and @{\extracolsep{\fill}} only pads, never
# shrinks. tabularx (X absorbs) and resizebox (scales down) are exempt.
LINE_BUDGET_CM = 16.5
# X-column blank: if a tabularx X column is allotted this many cm MORE than its
# widest cell needs, it shows a wide empty band — the flexible column was put on
# short content. Flagged only when a fixed p{} column simultaneously overflows
# its width (wraps), i.e. the X is on the wrong column.
X_SLACK_CM = 1.6
# A fixed p{Wcm} column whose widest cell exceeds W by this margin clearly wraps.
WRAP_MARGIN_CM = 0.3
# Row anchoring: every data row must carry at least this many corpus cite keys,
# so each of its cells is traceable to a paper. One is the whole requirement —
# a row about a single paper is normal, a row about none is not.
MIN_CITE_KEYS_PER_ROW = 1
# How many offending rows to name before truncating the problem string. Enough
# for the agent to see the pattern, short enough not to flood the status file.
MAX_REPORTED_ROWS = 5


# ============================================================================
# Regexes
# ============================================================================

_P_WIDTH_RE = re.compile(r"p\{\s*([0-9]+(?:\.[0-9]+)?)\s*cm\s*\}")
_CITE_RE = re.compile(r"~?\\cite[tp]?\{[^}]*\}")
# Same command family as _CITE_RE, but capturing the key list so rows can be
# checked for anchoring. Tolerates natbib's optional args: \citep[see][p.~3]{key}.
_CITE_KEYS_RE = re.compile(r"\\cite[tp]?\*?(?:\[[^\]]*\])*\{([^}]*)\}")
_CMD_RE = re.compile(r"\\[a-zA-Z]+")
_LONG_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-+/_.]{%d,}" % (LONG_TOKEN_LEN - 1))
# Unit-less TeX length assignment (e.g. `\hsize=0.15`) — triggers a compile
# error. The negative lookahead lets `\hsize=.5\hsize`, `\hsize=2cm` pass.
_BAD_LEN_RE = re.compile(
    r"\\(?:hsize|linewidth|textwidth|columnwidth|tabcolsep)\s*=\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?![\d.\\a-zA-Z])"
)
# Unescaped `%` — a LaTeX comment marker that silently truncates the rest of the
# line. `\%` is fine (the lookbehind excludes a preceding backslash).
_BARE_PERCENT_RE = re.compile(r"(?<!\\)%")

# A caption that starts by writing its own label. `\caption` already prints
# "Table 1." / "表 1." — the merged preamble sets `\captionsetup{labelsep=period}`
# for both languages — so a caption reading "表1:电力系统…" renders as
# "表 1. 表1:电力系统…". Nothing downstream can see this: the PDF text layer
# flattens it to one string, and it is not a LaTeX error, so it shipped in a
# finished survey and was caught only by a human reading page images.
# Column-prefix groups (>{...} <{...} @{...} !{...}) to strip before reading
# column letters; tolerates one level of brace nesting (e.g. @{\extracolsep{\fill}}).
_COL_PREFIX_RE = re.compile(r"[<>@!]\{(?:[^{}]|\{[^{}]*\})*\}")


# ============================================================================
# Low-level parsing
# ============================================================================

def _read_balanced_braces(text: str, start: int) -> tuple[str, int] | None:
    if start >= len(text) or text[start] != "{":
        return None
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            i += 2
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1: i], i + 1
        i += 1
    return None


def _extract_env(text: str, env_name: str) -> tuple[str, str] | None:
    """Find \\begin{env}...\\end{env}; return (col_spec, body) or None.

    For tabularx and tabular* the {\\linewidth} width arg is consumed before
    the col spec.
    """
    begin_marker = f"\\begin{{{env_name}}}"
    end_marker = f"\\end{{{env_name}}}"
    bi = text.find(begin_marker)
    if bi == -1:
        return None
    cursor = bi + len(begin_marker)
    while cursor < len(text) and text[cursor] in " \t\n":
        cursor += 1
    if env_name in ("tabularx", "tabular*"):
        if cursor >= len(text) or text[cursor] != "{":
            return None
        width_pair = _read_balanced_braces(text, cursor)
        if not width_pair:
            return None
        _, cursor = width_pair
        while cursor < len(text) and text[cursor] in " \t\n":
            cursor += 1
    if cursor >= len(text) or text[cursor] != "{":
        return None
    spec_pair = _read_balanced_braces(text, cursor)
    if not spec_pair:
        return None
    col_spec, after_spec = spec_pair
    ei = text.find(end_marker, after_spec)
    if ei == -1:
        return None
    return col_spec, text[after_spec:ei]


def _extract_resizebox_inner(text: str) -> str | None:
    marker = "\\resizebox"
    idx = text.find(marker)
    if idx == -1:
        return None
    cursor = idx + len(marker)
    args: list[str] = []
    for _ in range(3):
        while cursor < len(text) and text[cursor] in " \t\n":
            cursor += 1
        if cursor >= len(text) or text[cursor] != "{":
            return None
        pair = _read_balanced_braces(text, cursor)
        if not pair:
            return None
        arg, cursor = pair
        args.append(arg)
    width_arg, scale_arg, inner = args
    if "\\linewidth" not in width_arg or "!" not in scale_arg:
        return None
    return inner


def _sum_p_widths(col_spec: str) -> float:
    return sum(float(w) for w in _P_WIDTH_RE.findall(col_spec))


def _parse_columns(col_spec: str) -> list[tuple[str, float | None]]:
    """Return per-column (type, width_cm), e.g. [('X', None), ('p', 2.4)].

    p/m/b{width} collapse to type 'p' with the cm width (None if not in cm);
    >{...} prefixes and | rules are ignored.
    """
    s = _COL_PREFIX_RE.sub("", col_spec)
    cols: list[tuple[str, float | None]] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch in "lcrX":
            cols.append((ch, None))
            i += 1
        elif ch in "pmb" and i + 1 < len(s) and s[i + 1] == "{":
            pair = _read_balanced_braces(s, i + 1)
            if not pair:
                i += 1
                continue
            inner, after = pair
            m = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*cm", inner)
            cols.append(("p", float(m.group(1)) if m else None))
            i = after
        else:
            i += 1
    return cols


def _parse_col_types(col_spec: str) -> list[str]:
    """Per-column type letters only, e.g. ['p','c','c','X']."""
    return [t for t, _ in _parse_columns(col_spec)]


_RULE_MACRO_RE = re.compile(r"\\(?:top|mid|bottom)rule|\\cmidrule(?:\([^)]*\))?(?:\{[^}]*\})?")


def _data_grid(body: str) -> list[list[str]]:
    """Rows of cells from the region between the first \\midrule and the last
    \\bottomrule. Inner \\midrule separators (some tables rule every row) are
    stripped rather than treated as row boundaries, so no data row is dropped."""
    mid = body.find("\\midrule")
    end = body.rfind("\\bottomrule")
    region = body[mid + len("\\midrule"): end] if (mid != -1 and end != -1 and end > mid) else body
    region = _RULE_MACRO_RE.sub(" ", region)
    grid: list[list[str]] = []
    for raw in re.split(r"\\\\\s*", region):
        row = raw.strip()
        if not row or row.startswith("%"):
            continue
        grid.append([c.strip() for c in re.split(r"(?<!\\)&", row)])
    return grid


def _all_rows(body: str) -> list[list[str]]:
    """Every cell row (header + data) with the rule macros stripped — used for
    estimating natural row width."""
    b = _RULE_MACRO_RE.sub(" ", body)
    rows: list[list[str]] = []
    for raw in re.split(r"\\\\\s*", b):
        row = raw.strip()
        if not row or row.startswith("%"):
            continue
        rows.append([c.strip() for c in re.split(r"(?<!\\)&", row)])
    return rows


# ============================================================================
# Cell-level predicates
# ============================================================================

def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
        or 0xF900 <= o <= 0xFAFF or 0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF
    )


def _display_width(s: str) -> int:
    return sum(2 if _is_cjk(c) else 1 for c in s)


# Zero / near-zero-width markup that must NOT count toward a cell's printed
# width: \allowbreak (we explicitly tell the model to insert it after +/ to break
# long tokens — so it must not inflate the width measure) and thin/medium spaces.
_INVIS_RE = re.compile(r"\\allowbreak(?:\{\})?|\\[,;:!]")


def _visible(cell: str) -> str:
    """Cell text with citations and zero-width markup removed — what actually prints."""
    return _INVIS_RE.sub("", _CITE_RE.sub("", cell))


# Rough single-line print width (cm) of a cell under \small. CJK ≈ 0.32 cm/char,
# ASCII ≈ 0.18 cm/char; citations and \allowbreak markup are stripped first.
# Only used to estimate whether a fixed p{Wcm} column will wrap its content.
def _content_cm(cell: str) -> float:
    return sum(0.32 if _is_cjk(c) else 0.18 for c in _visible(cell))


def _cell_too_verbose(cell: str) -> str | None:
    text = _visible(cell).strip()
    if not text:
        return None
    if _display_width(text) > CELL_WIDTH_CAP:
        return f"{_display_width(text)}>width{CELL_WIDTH_CAP}"
    if len(text.split()) > CELL_WORD_CAP:
        return f"{len(text.split())}>words{CELL_WORD_CAP}"
    return None


def _long_token_in_cell(cell: str) -> str | None:
    stripped = _CMD_RE.sub(" ", _CITE_RE.sub(" ", cell))
    m = _LONG_TOKEN_RE.search(stripped)
    return m.group(0) if m else None


# ============================================================================
# Layout shell (also returns col_spec + body for the grid checks)
# ============================================================================

def _check_layout_shell(text: str) -> tuple[str | None, str | None, str | None, list[str]]:
    problems: list[str] = []

    tx = _extract_env(text, "tabularx")
    if tx:
        col_spec, body = tx
        bare_spec = re.sub(r">\{[^}]*\}", "", col_spec)
        if _sum_p_widths(col_spec) > P_BUDGET_TABULARX:
            problems.append(
                f"tabularx_p_width_over_budget:{_sum_p_widths(col_spec):.1f}cm>{P_BUDGET_TABULARX:.1f}cm"
            )
        if "X" not in bare_spec:
            problems.append("tabularx_missing_X_column")
        if "X" in bare_spec and "\\raggedright" not in col_spec:
            problems.append("tabularx_X_column_not_raggedright")
        problems.extend(_cell_problems(body))
        return "tabularx", col_spec, body, problems

    # Shell A2: tabular* + @{\extracolsep{\fill}} — fixed letters only, no X.
    ts = _extract_env(text, "tabular*")
    if ts:
        col_spec, body = ts
        bare_spec = re.sub(r">\{[^}]*\}", "", col_spec)
        if "X" in bare_spec:
            problems.append("tabular_star_has_X_column:X_only_works_in_tabularx")
        problems.extend(_cell_problems(body))
        return "tabular*", col_spec, body, problems

    inner = _extract_resizebox_inner(text)
    if inner is not None:
        tab = _extract_env(inner, "tabular")
        if not tab:
            problems.append("resizebox_without_tabular_inside")
            return "resizebox", None, None, problems
        col_spec, body = tab
        if _sum_p_widths(col_spec) > P_BUDGET_RESIZEBOX:
            problems.append(
                f"resizebox_p_width_over_budget:{_sum_p_widths(col_spec):.1f}cm>{P_BUDGET_RESIZEBOX:.1f}cm"
            )
        problems.extend(_cell_problems(body))
        return "resizebox", col_spec, body, problems

    if "\\begin{tabular}" in text:
        problems.append("bare_tabular_without_resizebox_or_tabularx")
    else:
        problems.append("missing_layout_shell")
    return None, None, None, problems


def _cell_problems(body: str) -> list[str]:
    """First verbosity / long-token offence in the data region (one of each)."""
    out: list[str] = []
    # Breakable prose length is a layout preference, not a machine-schema rule.
    # tabularx wraps it; inspect the rendered table rather than deleting evidence.
    for cell in (c for row in _data_grid(body) for c in row):
        tok = _long_token_in_cell(cell)
        if tok:
            out.append(
                f"unbreakable_ascii_run:{tok[:30]!r}:use_\\citet_or_abbrev_or_\\allowbreak_after_+//"
            )
            break
    return out


# ============================================================================
# Grid-level checks (column count, cite-in-narrow-col, form mixing, dead/uniform)
# ============================================================================

def _grid_problems(col_spec: str, body: str, shell: str | None) -> list[str]:
    problems: list[str] = []
    cols = _parse_columns(col_spec)
    col_types = [t for t, _ in cols]
    ncols = len(col_types)
    if ncols and not (COL_MIN <= ncols <= COL_MAX):
        problems.append(f"column_count_out_of_range:{ncols}_not_in_{COL_MIN}..{COL_MAX}")

    grid = _data_grid(body)
    if not grid:
        return problems

    # Row overflow in a non-wrapping tabular* (Shell A2): l/c/r cells cannot wrap
    # and @{\extracolsep{\fill}} only pads, so if the natural row width exceeds
    # \linewidth the table bleeds off the page. Estimate per-column natural width
    # (fixed p{} bounded by its W; l/c/r by their widest cell over header+data).
    if shell == "tabular*":
        rows = _all_rows(body)
        total = 0.28 * max(len(cols) - 1, 0)  # inter-column tabcolsep gaps
        for ci, (t, w) in enumerate(cols):
            cells = [r[ci] for r in rows if ci < len(r)]
            total += w if (t == "p" and w) else max((_content_cm(c) for c in cells), default=0.0)
        if total > LINE_BUDGET_CM:
            problems.append(
                f"row_too_wide_for_nonwrapping_shell:~{total:.1f}cm>{LINE_BUDGET_CM}cm:"
                "switch_to_tabularx_with_X_on_the_long_text_columns"
            )

    # Width misallocation: a tabularx that mixes a greedy X column with two or
    # more narrow fixed p{Wcm} text columns that actually overflow their width
    # (content wider than W → forced to wrap). The X hoards the leftover slack
    # while the pinned text columns wrap to 2-3 lines. Fix: make the wrapping
    # free-text columns X too (tabularx then shares width proportionally), or
    # widen them. (Shell A2 / resizebox have no flexible X to redistribute.)
    if shell == "tabularx" and any(t == "X" for t in col_types):
        wrapping_narrow = 0
        for ci, (t, w) in enumerate(cols):
            if t == "p" and w is not None and w <= NARROW_P_CM:
                col_cells = [r[ci] for r in grid if ci < len(r)]
                if any(_content_cm(c) > w for c in col_cells):
                    wrapping_narrow += 1
        if wrapping_narrow >= 2:
            problems.append(
                f"narrow_fixed_text_cols_wrap_beside_X:{wrapping_narrow}_cols_"
                "make_free_text_cols_X_or_widen_them"
            )

    # X put on the wrong column: the flexible X column sits on SHORT content, so
    # it is allotted far more width than it needs (a wide blank band down that
    # column), while a fixed p{} column holds LONG content and is forced to wrap
    # / makes the rows tall. Estimate the X column's allotted width = (linewidth
    # - every non-X column's width) and compare to its widest cell. Fix: move X
    # to the long column, or make both long columns X.
    if shell == "tabularx":
        x_idx = [i for i, (t, _) in enumerate(cols) if t == "X"]
        if x_idx:
            non_x = 0.28 * max(len(cols) - 1, 0)
            for ci, (t, w) in enumerate(cols):
                if t == "X":
                    continue
                cells = [r[ci] for r in grid if ci < len(r)]
                non_x += w if (t == "p" and w) else max((_content_cm(c) for c in cells), default=0.0)
            allotted_x = (LINE_BUDGET_CM - non_x) / len(x_idx)
            x_content = max(
                (_content_cm(r[ci]) for ci in x_idx for r in grid if ci < len(r)),
                default=0.0,
            )
            fixed_wraps = any(
                t == "p" and w and max((_content_cm(r[ci]) for r in grid if ci < len(r)), default=0.0)
                > w + WRAP_MARGIN_CM
                for ci, (t, w) in enumerate(cols)
            )
            if allotted_x - x_content > X_SLACK_CM and fixed_wraps:
                problems.append(
                    f"x_column_underfilled_while_fixed_col_wraps:X_has_~{allotted_x - x_content:.1f}cm_blank:"
                    "put_X_on_the_long_column(s)_and_pin_the_short_ones"
                )

    # cite_key in a non-wrapping (l/c) column → overflow. Only meaningful in
    # tabularx (Shell A), where X / p are available alternatives; Shell A2
    # (tabular*) deliberately uses l/c/r for its short-cite identity column, so
    # the genuine A2 overflow case is caught by the unbreakable-run check instead.
    if shell == "tabularx":
        for row in grid:
            hit = False
            for ci, cell in enumerate(row):
                if "\\cite" in cell and ci < len(col_types) and col_types[ci] in ("l", "c"):
                    problems.append(f"cite_in_nonwrapping_column:col{ci + 1}_is_{col_types[ci]}")
                    hit = True
                    break
            if hit:
                break

    # Column 1 citation form must not mix \citet{} and <name>~\citep{}.
    forms: set[str] = set()
    for row in grid:
        if not row:
            continue
        c0 = row[0]
        if re.match(r"^\\citet\{", c0) and not _CITE_RE.sub("", c0).strip():
            forms.add("citet")
        elif "\\citep" in c0 or "\\cite{" in c0:
            forms.add("citep")
    if "citet" in forms and "citep" in forms:
        problems.append("mixed_citation_forms_in_col1")

    # Non-identity column (idx > 0) that is dead (all '-') or non-discriminating
    # (identical value across every row) — drop it.
    ncol = max((len(r) for r in grid), default=0)
    for ci in range(1, ncol):
        vals = [_CITE_RE.sub("", r[ci]).strip() for r in grid if ci < len(r)]
        nonempty = [v for v in vals if v]
        if len(nonempty) < UNIFORM_MIN_ROWS:
            continue
        uniq = set(nonempty)
        if uniq == {"-"}:
            problems.append(f"dead_column:col{ci + 1}_all_missing")
        elif len(uniq) == 1:
            problems.append(f"non_discriminating_column:col{ci + 1}_all={nonempty[0][:20]!r}")
    return problems


# ============================================================================
# Row anchoring — every row must trace back to a paper
# ============================================================================

def cite_keys_in(text: str) -> list[str]:
    """Every cite key referenced by `text`, in order, duplicates included."""
    keys: list[str] = []
    for group in _CITE_KEYS_RE.findall(text or ""):
        for key in group.split(","):
            key = key.strip()
            if key:
                keys.append(key)
    return keys


def _is_structural_row(row: list[str]) -> bool:
    """A spanning group header (`\\multicolumn{4}{l}{Sparse retrieval}`) rather
    than a data row. It compares nothing, so it anchors to nothing."""
    nonempty = [c for c in row if c.strip()]
    return len(nonempty) <= 1 and any("\\multicolumn" in c for c in row)


def _row_anchor_problems(body: str, allowed_cite_keys) -> list[str]:
    """Every data row must cite at least one paper, from the table's own list.

    Two separate failures, reported separately because the repairs differ:
      * a row with no cite key at all — the row has no source, so drop it or
        cite the paper it came from;
      * a row citing a key outside the table's assigned papers — the content
        came from somewhere the table was not given, which is either a typo or
        a paper the table may not use.
    """
    problems: list[str] = []
    grid = _data_grid(body)
    if not grid:
        return problems

    allowed = {k.strip() for k in (allowed_cite_keys or []) if str(k).strip()}
    unanchored: list[int] = []
    foreign: dict[str, int] = {}

    for idx, row in enumerate(grid, start=1):
        if _is_structural_row(row):
            continue
        keys = cite_keys_in(" ".join(row))
        if len(keys) < MIN_CITE_KEYS_PER_ROW:
            unanchored.append(idx)
            continue
        if allowed:
            for key in keys:
                if key not in allowed and key not in foreign:
                    foreign[key] = idx

    if unanchored:
        shown = ",".join(str(i) for i in unanchored[:MAX_REPORTED_ROWS])
        more = "+" if len(unanchored) > MAX_REPORTED_ROWS else ""
        problems.append(
            f"row_without_cite_key:row{shown}{more}:"
            "every_data_row_must_cite_>=1_paper_from_the_item's_papers_"
            "(use_\\citet{key}_in_the_identity_column)"
        )
    if foreign:
        shown = ",".join(
            f"{key}@row{row}" for key, row in list(foreign.items())[:MAX_REPORTED_ROWS]
        )
        problems.append(
            f"row_cites_paper_outside_the_table:{shown}:"
            "only_cite_key_values_listed_in_the_worklist_item's_papers"
        )
    return problems


# ============================================================================
# Public entry point
# ============================================================================

def collect_problems(text: str, expected_label: str = "",
                     allowed_cite_keys=None) -> list[str]:
    """Return every shape problem in one table's LaTeX block (empty == clean).

    `allowed_cite_keys` is the cite_key list of the worklist item's `papers`.
    When supplied, row anchoring also checks that no row cites a paper the table
    was not given. When omitted, only the "every row cites something" half runs
    — callers without the worklist still get the anchoring guarantee.
    """
    if not text or not text.strip():
        return ["empty_response"]

    problems: list[str] = []

    if "\\begin{table}" not in text or "\\end{table}" not in text:
        problems.append("missing_table_environment")
    elif not re.search(r"\\begin\{table\}\[t\]", text):
        problems.append("wrong_placement_specifier:expected_[t]")

    if "\\toprule" not in text:
        problems.append("missing_rule_macros:need_\\toprule")
    if "\\hline" in text:
        problems.append("hline_forbidden:use_\\toprule/\\midrule/\\bottomrule")

    if expected_label and f"\\label{{{expected_label}}}" not in text:
        problems.append(f"missing_required_label:{expected_label}")
    if "\\caption{" not in text:
        problems.append("missing_caption")
    else:
        caption = _read_balanced_braces(text, text.index("\\caption{") + len("\\caption"))
        if caption and has_numbering_prefix(caption[0]):
            problems.append(
                "caption_repeats_its_own_label:\\caption_already_prints_"
                "'表 N.'/'Table N.'_so_drop_the_prefix_from_the_text")

    if _BARE_PERCENT_RE.search(text):
        problems.append("unescaped_percent:write_\\%_or_it_truncates_the_line")
    if _BAD_LEN_RE.search(text):
        problems.append("length_without_unit:hsize_or_similar")

    shell, col_spec, body, layout_problems = _check_layout_shell(text)
    problems.extend(layout_problems)
    if col_spec is not None and body is not None:
        problems.extend(_grid_problems(col_spec, body, shell))
        problems.extend(_row_anchor_problems(body, allowed_cite_keys))

    return problems
