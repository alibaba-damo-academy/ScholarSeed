"""Render LaTeX asset fragments and citations for Markdown publication/fallback.

Tables come from structured manuscript authoring and script rendering; the figure
author supplies native forest bodies. Conversion is deterministic."""
from __future__ import annotations

import re
from pathlib import Path

__all__ = [
    "ASSET_LABELS",
    "scan_tables", "scan_figures",
    "render_table_md", "render_figure_md",
    "rewrite_lists", "cleanup_text",
    "extract_cmd_arg", "balanced_braces",
]

ASSET_LABELS = {
    "english": {"figure": "Figure", "table": "Table",
                "references": "References", "appendix": "Appendix: Assets"},
    "chinese": {"figure": "图", "table": "表",
                "references": "参考文献", "appendix": "附录：图表"},
}


def labels_for(language: str) -> dict:
    return ASSET_LABELS.get(language, ASSET_LABELS["english"])


# ---------------------------------------------------------------------------
# LaTeX micro-parsing
# ---------------------------------------------------------------------------


def balanced_braces(text: str, brace_pos: int) -> str:
    """Given `text[brace_pos] == '{'`, return the inner content."""
    depth, j = 1, brace_pos + 1
    while j < len(text) and depth > 0:
        if text[j] == "\\" and j+1 < len(text):
            j += 2
            continue
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
        j += 1
    return text[brace_pos + 1:j - 1]


def extract_cmd_arg(text: str, cmd: str) -> str | None:
    """Find `\\cmd[opt]?{arg}` and return `arg`, brace-balanced."""
    pattern = re.compile(r"\\" + re.escape(cmd) + r"\b(?:\[[^\]]*\])?\s*\{")
    match = pattern.search(text)
    if not match:
        return None
    return balanced_braces(text, match.end() - 1)


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------

_TABULAR_BEGIN_RE = re.compile(r"\\begin\{(tabular\*?|tabularx)\}")
_TABULAR_END_RE = re.compile(r"\\end\{(tabular\*?|tabularx)\}")
_ROW_SEP_RE = re.compile(r"\\\\(?:\s*\[[^\]]*\])?")
_RULE_RE = re.compile(
    r"\\(?:toprule|midrule|bottomrule|hline|cmidrule(?:\([^)]*\))?\{[^}]*\})"
)
_CELL_SEP_RE = re.compile(r"(?<!\\)&")
_MULTICOL_START = re.compile(r"^\s*\\multicolumn\b\s*\{(\d+)\}\s*\{[^}]*\}\s*\{")
_MULTIROW_START = re.compile(r"^\s*\\multirow\*?\s*\{(\d+)\}\s*\{[^}]*\}\s*\{")

_COLSPEC_TOKEN_RE = re.compile(
    r"""
      (?P<deco>>\{[^}]*\}|<\{[^}]*\}|@\{[^}]*\}|!\{[^}]*\})  # tabular decorations
    | (?P<width>[pmb])\{[^}]*\}                              # p{w}, m{w}, b{w}
    | (?P<simple>[lcrX|])                                    # l, c, r, X, |
    | (?P<ws>\s+)
    """,
    re.VERBOSE,
)

_HTML_ALIGN = {":---": "left", ":---:": "center", "---:": "right"}


def _consume_tabular_header(text: str, env_end: int) -> tuple[str, int] | None:
    """Consume the optional width argument plus the column spec after
    `\\begin{tabular*?|tabularx}`. Returns `(colspec, pos_after)`."""
    i, n = env_end, len(text)
    while i < n and text[i].isspace():
        i += 1
    if i < n and text[i] == "{":            # width arg: tabularx / tabular*
        inner = balanced_braces(text, i)
        i += 1 + len(inner) + 1
        while i < n and text[i].isspace():
            i += 1
    if i >= n or text[i] != "{":
        return None
    colspec = balanced_braces(text, i)
    return colspec, i + 1 + len(colspec) + 1


def _classify_colspec(spec: str) -> tuple[bool, list[str]]:
    """Return `(every_token_recognised, gfm_alignment_row)`.

    Width information is discarded — GFM has no per-column width concept, so
    `p{3cm}` and `l` are the same thing once the table is a pipe table.
    """
    aligns: list[str] = []
    pos = 0
    while pos < len(spec):
        match = _COLSPEC_TOKEN_RE.match(spec, pos)
        if not match:
            return False, []
        if match.group("simple"):
            char = match.group("simple")
            if char == "c":
                aligns.append(":---:")
            elif char == "r":
                aligns.append("---:")
            elif char in ("l", "X"):
                aligns.append(":---")
            # `|` silently dropped — GFM has no vertical rule notion.
        elif match.group("width"):
            aligns.append(":---")
        pos = match.end()
    return True, aligns


def _split_cells(raw: str) -> list[str]:
    return [c.strip() for c in _CELL_SEP_RE.split(raw)]


def _parse_cell_spans(cell: str) -> tuple[str, int, int]:
    """Peel `\\multicolumn` / `\\multirow` wrappers. Returns
    `(content, colspan, rowspan)`."""
    colspan = rowspan = 1
    work = cell
    while True:
        match = _MULTICOL_START.match(work)
        if match:
            colspan *= int(match.group(1))
            work = balanced_braces(work, match.end() - 1).strip()
            continue
        match = _MULTIROW_START.match(work)
        if match:
            rowspan *= int(match.group(1))
            work = balanced_braces(work, match.end() - 1).strip()
            continue
        break
    return work, colspan, rowspan


def scan_tables(tables_dir: Path) -> dict[str, dict]:
    """Parse every `tables/*.tex` into a render-ready record.

    Keys are the label WITHOUT the `tab:` prefix, which is how prose refers to
    them once `\\ref{tab:T1}` has been split.
    """
    out: dict[str, dict] = {}
    tables_dir = Path(tables_dir)
    if not tables_dir.exists():
        return out
    for tex_path in sorted(tables_dir.glob("*.tex")):
        text = tex_path.read_text(encoding="utf-8", errors="ignore")
        label_full = extract_cmd_arg(text, "label") or ""
        if not label_full.startswith("tab:"):
            continue
        label = label_full.split(":", 1)[1]
        record: dict = {
            "label": label,
            "caption": (extract_cmd_arg(text, "caption") or "").strip(),
            "src_tex": str(tex_path),
            "render_mode": "html",
            "align": [], "rows": [], "rows_html": [],
            "fallback_reason": "no_tabular_block",
        }

        begin = _TABULAR_BEGIN_RE.search(text)
        end = _TABULAR_END_RE.search(text)
        if not (begin and end and end.start() > begin.end()):
            out[label] = record
            continue

        header = _consume_tabular_header(text, begin.end())
        if header is None or header[1] > end.start():
            record["fallback_reason"] = "unparseable_tabular_header"
            out[label] = record
            continue
        colspec, body_start = header
        colspec_ok, aligns = _classify_colspec(colspec)
        body = _RULE_RE.sub("", text[body_start:end.start()])

        parsed_rows: list[list[tuple[str, int, int]]] = []
        for raw in _ROW_SEP_RE.split(body):
            raw = raw.strip()
            if not raw:
                continue
            row = [_parse_cell_spans(c) for c in _split_cells(raw)]
            if any(content for content, _, _ in row):
                parsed_rows.append(row)

        if not parsed_rows:
            record["fallback_reason"] = "no_rows"
            out[label] = record
            continue

        record["align"] = aligns
        any_span = any(cs > 1 or rs > 1 for row in parsed_rows for _, cs, rs in row)
        arity_ok = colspec_ok and all(
            sum(cs for _, cs, _ in row) == len(aligns) for row in parsed_rows)

        if not any_span and arity_ok:
            record["render_mode"] = "gfm"
            record["rows"] = [[c for c, _, _ in row] for row in parsed_rows]
            record["fallback_reason"] = None
        else:
            record["rows_html"] = parsed_rows
            record["fallback_reason"] = (
                "has_spans" if any_span
                else ("colspec_unknown_token" if not colspec_ok
                      else "row_arity_mismatch"))
        out[label] = record
    return out


def _html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_MD_LINK_NUM_RE = re.compile(r"\[\[(\d+)\]\]\(#([^)]+)\)")
_MD_LINK_GENERIC_RE = re.compile(r"\[([^\]]+)\]\(#([^)]+)\)")


def _md_anchor_links_to_html(text: str) -> str:
    """`[[1]](#a)` / `[t](#a)` -> inline `<a href>` so they still render inside
    a `<td>`, which many previewers do not recurse markdown into."""
    text = _MD_LINK_NUM_RE.sub(r'<a href="#\2">[\1]</a>', text)
    return _MD_LINK_GENERIC_RE.sub(r'<a href="#\2">\1</a>', text)


def render_table_md(meta: dict, number: int, language: str = "english",
                    cell_filter=None) -> str:
    """Render one table record as a Markdown block with an anchor and caption.

    `cell_filter` is applied to every cell and to the caption. The Markdown path
    passes `None` (citations are resolved later, document-wide); the LaTeX
    fallback passes its citation registry's rewriter, because it resolves as it
    goes.
    """
    apply = cell_filter or cleanup_text
    word = labels_for(language)["table"]
    lines = [
        f'<a id="tab-{meta["label"]}"></a>',
        "",
        f'**{word} {number}.** {apply(meta["caption"])}',
        "",
    ]
    if meta.get("render_mode") == "gfm":
        lines += _render_table_gfm(meta, apply)
    else:
        lines += _render_table_html(meta, apply)
    return "\n".join(lines)


def _render_table_gfm(meta: dict, apply) -> list[str]:
    rendered = [
        [apply(cell).replace("|", "\\|").replace("\n", " ") for cell in row]
        for row in meta["rows"]
    ]
    header = "| " + " | ".join(rendered[0]) + " |"
    separator = "| " + " | ".join(meta["align"]) + " |"
    return [header, separator] + ["| " + " | ".join(r) + " |" for r in rendered[1:]]


def _render_table_html(meta: dict, apply) -> list[str]:
    aligns = meta.get("align") or []
    rows = meta.get("rows_html") or []
    if not rows:
        return ["<table></table>"]

    def attrs(col_idx: int, colspan: int, rowspan: int) -> str:
        parts: list[str] = []
        if colspan > 1:
            parts.append(f'colspan="{colspan}"')
        if rowspan > 1:
            parts.append(f'rowspan="{rowspan}"')
        if col_idx < len(aligns):
            align = _HTML_ALIGN.get(aligns[col_idx])
            if align and align != "left":
                parts.append(f'style="text-align:{align}"')
        return (" " + " ".join(parts)) if parts else ""

    def cell(content: str) -> str:
        return _md_anchor_links_to_html(_html_escape(apply(content)))

    lines = ["<table>", "<thead><tr>"]
    col = 0
    for content, colspan, rowspan in rows[0]:
        lines.append(f"<th{attrs(col, colspan, rowspan)}>{cell(content)}</th>")
        col += colspan
    lines.append("</tr></thead>")
    if rows[1:]:
        lines.append("<tbody>")
        for row in rows[1:]:
            lines.append("<tr>")
            col = 0
            for content, colspan, rowspan in row:
                lines.append(f"<td{attrs(col, colspan, rowspan)}>{cell(content)}</td>")
                col += colspan
            lines.append("</tr>")
        lines.append("</tbody>")
    lines.append("</table>")
    return lines


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------

_FOREST_BLOCK_RE = re.compile(r"\\begin\{forest\}(.*?)\\end\{forest\}", re.DOTALL)

# Keys a figure's worklist metadata may carry a rendered raster under. Probed in
# order and used as-is when the value looks like an image path. Probing rather
# than naming one key is what lets a new render mode (a chart writer, say) drop
# a PNG next to the figure without this module learning how it was produced.
_IMAGE_META_KEYS = (
    "_image_path", "image_path", "_image", "_png", "_png_path",
    "_generated_path", "_render_path", "_asset_path",
)
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf")


def _image_from_meta(item: dict) -> str | None:
    for key in _IMAGE_META_KEYS:
        value = item.get(key)
        if isinstance(value, str) and value.strip().lower().endswith(_IMAGE_SUFFIXES):
            return value.strip()
    return None


def _node_label(raw: str) -> str:
    """A forest node's own text runs up to its first top-level comma, after
    which come the options (`fill=blue`, `edge=dashed`) that describe how a box
    is drawn. There is no box, so they are dropped."""
    depth = 0
    for i, char in enumerate(raw):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif char == "," and depth == 0:
            raw = raw[:i]
            break
    return cleanup_text(raw)


def _first_top_level_bracket(text: str) -> int:
    """Index of the first `[` not inside braces — where the tree starts, past
    forest's `for tree={...}` styling preamble."""
    depth = 0
    for i, char in enumerate(text):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif char == "[" and depth == 0:
            return i
    return -1


def _forest_to_bullets(latex_body: str) -> list[str]:
    """Turn a `\\begin{forest}[A[B][C]]\\end{forest}` body into a nested list.

    Forest's tree syntax is plain bracket nesting, so this is a bracket walk,
    not a LaTeX parse. One pass, emitting a parent's bullet the moment its
    bracket opens, which is exactly document order.
    """
    match = _FOREST_BLOCK_RE.search(latex_body or "")
    inner = match.group(1) if match else (latex_body or "")
    start = _first_top_level_bracket(inner)
    if start < 0:
        return []

    lines: list[str] = []
    depth = 0        # nesting level of the node we are inside
    brace = 0        # brace depth, so `{a, b}` is not read as structure
    i = start
    while i < len(inner):
        char = inner[i]
        if char == "{":
            brace += 1
        elif char == "}":
            brace -= 1
        elif brace == 0 and char == "[":
            # This node's own text ends at the next structural bracket.
            j, inner_brace = i + 1, 0
            while j < len(inner):
                if inner[j] == "{":
                    inner_brace += 1
                elif inner[j] == "}":
                    inner_brace -= 1
                elif inner_brace == 0 and inner[j] in "[]":
                    break
                j += 1
            label = _node_label(inner[i + 1:j])
            if label:
                lines.append(f"{'  ' * depth}- {label}")
            depth += 1
        elif brace == 0 and char == "]":
            depth = max(0, depth - 1)
        i += 1
    return lines


def scan_figures(figures_dir: Path, worklist_items: list[dict] | None = None,
                 image_prefix: str = "./figures") -> dict[str, dict]:
    """Return `{label_without_prefix: record}` for every renderable figure.

    Both sources are consulted and neither is trusted alone. `figures/*.tex` is
    what actually reached the document — a figure the LaTeX writer dropped has
    no `.tex` and must not appear in the Markdown either. The worklist is where
    a render mode records what it produced, and it is read GENERICALLY: any
    metadata key that looks like an image path is taken as one. That is what
    lets a mode this module has never heard of (a chart renderer writing a PNG,
    say) be embedded correctly without this module being taught about it.
    """
    figures_dir = Path(figures_dir)
    by_id = {it.get("figure_id"): it for it in (worklist_items or [])
             if isinstance(it, dict) and it.get("figure_id")}

    out: dict[str, dict] = {}
    if not figures_dir.exists():
        return out
    for tex_path in sorted(figures_dir.glob("*.tex")):
        text = tex_path.read_text(encoding="utf-8", errors="ignore")
        label_full = extract_cmd_arg(text, "label") or ""
        if not label_full.startswith("fig:"):
            continue
        label = label_full.split(":", 1)[1]
        item = by_id.get(tex_path.stem, {})

        # Image path, most authoritative source first: what the render mode
        # recorded, then what the LaTeX wrapper points at, then the
        # by-convention PNG. Any of the three may legitimately be absent.
        image = _image_from_meta(item)
        if not image:
            graphic = extract_cmd_arg(text, "includegraphics")
            if graphic:
                image = graphic
        if not image and (figures_dir / f"{tex_path.stem}.png").exists():
            image = f"{tex_path.stem}.png"

        bullets: list[str] = []
        if not image:
            body = item.get("_latex_body") or text
            bullets = _forest_to_bullets(body)

        out[label] = {
            "label": label,
            "caption": (extract_cmd_arg(text, "caption") or "").strip(),
            "src_tex": str(tex_path),
            "render_mode": item.get("_render_mode") or ("image" if image else "forest_taxonomy"),
            "image": f"{image_prefix}/{Path(image).name}" if image else "",
            "bullets": bullets,
        }
        # Preserve plain figure captions across the TeX transport wrapper. A
        # manually changed wrapper remains authoritative if it no longer matches.
        if item.get('_caption'):
            from figure_caption import caption_text, caption_latex
            try:
                if caption_latex(item['_caption']) == out[label]['caption']:
                    out[label]['caption_plain'] = caption_text(item['_caption'])
            except ValueError:
                pass
    return out


def render_figure_md(meta: dict, number: int, language: str = "english",
                     caption_filter=None) -> str:
    """Render one figure as a Markdown block: image or nested bullet list."""
    apply = caption_filter or cleanup_text
    word = labels_for(language)["figure"]
    if "caption_plain" in meta:
        from figure_caption import caption_markdown
        caption = caption_markdown(meta["caption_plain"])
    else:
        caption = apply(meta["caption"])
    lines = [f'<a id="fig-{meta["label"]}"></a>', ""]
    if meta.get("image"):
        lines.append(f'![{word} {number}]({meta["image"]})')
    elif meta.get("bullets"):
        lines += meta["bullets"]
    else:
        # No raster and no parseable hierarchy: say so rather than emit a
        # broken image link. The caption still carries the content.
        lines.append(f"_{word} {number} has no renderable body._")
    lines += ["", f"**{word} {number}.** {caption}"]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Prose-level LaTeX residue
# ---------------------------------------------------------------------------

_LIST_BLOCK_RE = re.compile(
    r"\\begin\{(itemize|enumerate|description)\}\s*(.*?)\\end\{\1\}", re.DOTALL)
_ITEM_RE = re.compile(r"\\item(?:\[([^\]]*)\])?\s*")


def rewrite_lists(text: str) -> str:
    """`itemize`/`enumerate`/`description` -> GFM lists, innermost first."""
    def render(match: re.Match) -> str:
        env, body = match.group(1), match.group(2)
        parts = _ITEM_RE.split(body)
        if len(parts) < 3:
            return ""
        out = [""]
        index = 0
        for i in range(1, len(parts), 2):
            label = parts[i]
            content = " ".join((parts[i + 1] if i + 1 < len(parts) else "").split())
            if not content:
                continue
            index += 1
            if env == "enumerate":
                out.append(f"{index}. {content}")
            elif env == "description" and label:
                out.append(f"- **{label}** {content}")
            else:
                out.append(f"- {content}")
        out.append("")
        return "\n".join(out)

    previous = None
    while previous != text:
        previous = text
        text = _LIST_BLOCK_RE.sub(render, text)
    return text


def cleanup_text(text: str) -> str:
    """Strip residual LaTeX from a fragment destined for Markdown."""
    # KaTeX/remarkMath only parses `$...$`, so `\(\times\)` would render
    # literally (`25.7\(\times\)` instead of `25.7×`). Scoped to `\times` only.
    text = re.sub(r"\\\(\s*\\times\s*\\\)", "×", text)
    text = re.sub(r"\$\s*\\times\s*\$", "×", text)
    text = re.sub(r"\\(emph|textit)\{([^}]+)\}", r"_\2_", text)
    text = re.sub(r"\\textbf\{([^}]+)\}", r"**\1**", text)
    text = re.sub(r"\\texttt\{([^}]+)\}", r"`\1`", text)
    text = re.sub(r"\x09exttt\{([^}]+)\}", r"`\1`", text)
    text = re.sub(r"\\todo\[[^\]]*\]\{([^}]*)\}", r"_TODO: \1_", text)
    text = re.sub(r"\\noindent\s*", "", text)
    text = text.replace("~", " ")
    text = re.sub(r"\\([%&_#$])", r"\1", text)
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r" +([.,;:!?])", r"\1", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()
