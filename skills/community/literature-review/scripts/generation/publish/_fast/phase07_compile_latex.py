"""Phase 7 — LaTeX compile (no LLM).

Compiles {workspace}/05_generation/full_draft_v3.tex with pdflatex +
bibtex (post 2026-05 refactor). Falls back through v2 → v1 if v3 isn't
present, so partial runs still produce a PDF for smoke-testing.

On success: copies the PDF to {workspace}/06_output/survey.pdf.
On compile failure: by default the Markdown fallback is DEFERRED — only a
diagnosis-bearing status JSON is written and 06_output/ is left untouched, so
the agent's compile fix loop can revise the source first. Pass
--emit-fallback-on-failure (the agent does this after exhausting its fix
attempts) to write the Markdown fallback at
{workspace}/06_output/survey_fallback.md. Engine-missing and --md-only still
emit the fallback immediately (there is nothing for the fix loop to repair).
Either way the call returns PARTIAL_SUCCESS.

This phase runs in both `speed` and `deep` scopes. `--scope` is retained
so the status row records which mode the run belongs to, but it no longer
controls execution.

The workspace root is used as the LaTeX working directory so that
\\input{05_generation/...} paths resolve correctly.
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
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
pass
from writing_contract import load_outline
from _utils import (  # noqa: E402
    Workspace,
    iter_all_sections,
    load_json,
    log_debug,
    log_script_start,
    write_status,
)
from output_spec import read_output_spec  # noqa: E402
from citation_styles import CITATION_STYLES  # noqa: E402
import citation_formats  # noqa: E402
from latex_to_markdown import (  # noqa: E402
    cleanup_text,
    labels_for,
    render_figure_md,
    render_table_md,
    rewrite_lists,
    scan_figures,
    scan_tables,
)


def _which(name: str) -> str | None:
    return shutil.which(name)


def _run(cmd: list[str], cwd: Path, timeout: int = 180,
         env: dict | None = None) -> tuple[int, str]:
    proc = subprocess.run(
        cmd, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        env=env,
    )
    return proc.returncode, (proc.stdout + "\n" + proc.stderr)[-8000:]


def _diagnose_compile(pdf_path: Path, log_path: Path,
                      final_pass_rc: int) -> dict:
    """Inspect compile artefacts and classify the run.

    Returns a verdict so the caller can decide whether the PDF on disk is a
    complete deliverable, a truncated partial that should not be promoted, or
    absent altogether:

      - "clean"        — PDF exists, final pass returned 0, no fatal errors,
                         no "Emergency stop", no driver "may not be valid".
      - "partial_pdf"  — PDF exists on disk but the log shows the engine
                         halted on an error (the classic case: pdflatex
                         flushes whatever pages it had buffered before
                         aborting, leaving a truncated PDF).
      - "no_pdf"       — PDF missing or zero bytes.
    """
    pdf_exists = pdf_path.exists()
    pdf_bytes = pdf_path.stat().st_size if pdf_exists else 0

    fatal_errors: list[str] = []
    error_contexts: list[str] = []
    log_warnings: list[str] = []
    emergency_stop = False
    driver_error = False

    if log_path.exists():
        text = log_path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        for index, line in enumerate(lines):
            stripped = line.strip()
            if line.startswith("!"):
                fatal_errors.append(stripped)
                if len(error_contexts) < 5:
                    error_contexts.append("\n".join(lines[index:index + 8]))
            elif "Overfull" in line or "LaTeX Warning" in line:
                log_warnings.append(stripped)
            if "Emergency stop" in line:
                emergency_stop = True
            if "may not be valid" in line and re.search(r"Error \d+", line):
                driver_error = True

    if not pdf_exists or pdf_bytes == 0:
        verdict = "no_pdf"
    elif (
        final_pass_rc == 0
        and not fatal_errors
        and not emergency_stop
        and not driver_error
    ):
        verdict = "clean"
    else:
        verdict = "partial_pdf"

    return {
        "verdict": verdict,
        "pdf_exists": pdf_exists,
        "pdf_bytes": pdf_bytes,
        "final_pass_rc": final_pass_rc,
        "fatal_errors": fatal_errors,
        "error_contexts": error_contexts,
        "log_path": str(log_path),
        "emergency_stop": emergency_stop,
        "driver_error": driver_error,
        "log_warnings": log_warnings,
    }


_BUNDLE_INPUT_REWRITE_RE = re.compile(
    r"\\input\{\s*05_generation/(figures|tables)/([^}]+?)\s*\}"
)


def _purge_stale_outputs(ws: Workspace, language: str,
                         markdown: bool = False) -> list[str]:
    """Remove anything in 06_output/ that isn't part of the current bundle.

    Called only once the deliverable is on disk and the bundle around it has
    been refreshed in place. Whatever is left over is from a previous failed
    compile (e.g. survey_fallback.md), a prior run with different settings
    (e.g. neurips_2025.sty after a template migration, or a stale .sty after a
    language flip), or a prior run in the other
    dialect — a `survey.pdf` sitting next to a `survey.md` is a user handing
    their supervisor the wrong file.
    """
    if markdown:
        return _purge_to(ws, {"survey.md", "references.md", "citations.bib", "disclaimer.md",
                              "figures", "tables"})

    style = CITATION_STYLES[read_output_spec(ws.root)["citation_style"]]
    expected = {
        "survey.pdf",
        "survey.tex",
        "survey.aux",
        "citations.bib",
        "disclaimer.md",
        "figures",
        "tables",
        f"{style['bst']}.bst",
    }
    if language == "english":
        expected.add("neurips_2026.sty")
    return _purge_to(ws, expected)


def _purge_to(ws: Workspace, expected: set[str]) -> list[str]:
    """Delete every entry of 06_output/ whose name is not in `expected`."""
    removed: list[str] = []
    if not ws.output.exists():
        return removed
    for entry in ws.output.iterdir():
        if entry.name in expected:
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed.append(entry.name)
    return removed


def _publish_latex_bundle(ws: Workspace, src_path: Path,
                          language: str) -> dict:
    """Mirror the final LaTeX source + supporting assets into 06_output/.

    Copies (or rewrites, for survey.tex) the four artefacts that make the
    deliverable self-contained:

    - 06_output/survey.tex          ← src_path with `\\input{05_generation/...}`
                                      rewritten to be relative to 06_output/.
    - 06_output/citations.bib       ← 05_generation/citations.bib
    - 06_output/figures/{*.tex,*.png} ← 05_generation/figures/*
    - 06_output/tables/*.tex        ← 05_generation/tables/*
    - 06_output/neurips_2026.sty    ← only when present (English mode).

    Always runs, regardless of whether pdflatex succeeded — the .tex source is
    the closest thing we have to a deliverable on compile failure.

    Returns a dict describing the bundle for the status row.
    """
    ws.output.mkdir(parents=True, exist_ok=True)

    # 1. survey.tex with rewritten \input{} paths.
    tex_src = src_path.read_text(encoding="utf-8")
    tex_out = _BUNDLE_INPUT_REWRITE_RE.sub(r"\\input{\1/\2}", tex_src)
    ws.survey_tex_path.write_text(tex_out, encoding="utf-8")

    bundle: dict = {
        "survey_tex": str(ws.survey_tex_path),
        "source_tex": str(src_path),
    }

    # 2. citations.bib (optional — phase 2 always emits it but be defensive).
    if ws.citations_bib_path.exists():
        shutil.copyfile(ws.citations_bib_path, ws.survey_citations_bib_path)
        bundle["citations_bib"] = str(ws.survey_citations_bib_path)

    # 3. figures/ and tables/ as a whole — replace any prior copy so stale
    # assets from earlier runs don't linger.
    figures_copied = 0
    if ws.figures_dir.exists():
        if ws.survey_figures_dir.exists():
            shutil.rmtree(ws.survey_figures_dir)
        shutil.copytree(ws.figures_dir, ws.survey_figures_dir)
        figures_copied = sum(1 for _ in ws.survey_figures_dir.iterdir())
    bundle["figures_dir"] = str(ws.survey_figures_dir)
    bundle["figures_files"] = figures_copied

    tables_copied = 0
    if ws.tables_dir.exists():
        if ws.survey_tables_dir.exists():
            shutil.rmtree(ws.survey_tables_dir)
        shutil.copytree(ws.tables_dir, ws.survey_tables_dir)
        tables_copied = sum(1 for _ in ws.survey_tables_dir.iterdir())
    bundle["tables_dir"] = str(ws.survey_tables_dir)
    bundle["tables_files"] = tables_copied

    # 4. NeurIPS style file — English mode only. Phase 2 staged it into
    # 05_generation/; mirror it so the bundle compiles standalone.
    sty_src = ws.gen / "neurips_2026.sty"
    if language == "english" and sty_src.exists():
        shutil.copyfile(sty_src, ws.survey_neurips_sty_path)
        bundle["neurips_sty"] = str(ws.survey_neurips_sty_path)

    # 4b. Selected bibliography style — phase 5 staged the vendored asset.
    style = CITATION_STYLES[read_output_spec(ws.root)["citation_style"]]
    bst_src = ws.gen / f"{style['bst']}.bst"
    if bst_src.exists():
        bst_out = ws.output / bst_src.name
        shutil.copyfile(bst_src, bst_out)
        bundle["bst"] = str(bst_out)

    # 5. LaTeX .aux file — only present after a successful compile pass.
    # Mirrored so the frontend can read citation/label metadata without
    # re-running the engine. Silently skipped when absent (md-only, engine
    # missing, or compile aborted before the first pass produced .aux).
    aux_src = ws.gen / f"{src_path.stem}.aux"
    if aux_src.exists():
        shutil.copyfile(aux_src, ws.survey_aux_path)
        bundle["aux"] = str(ws.survey_aux_path)

    return bundle


# ----------------------------------------------------------------------------
# Markdown fallback — supporting parsers and renderers
# ----------------------------------------------------------------------------


_BIB_ENTRY_RE = re.compile(r"@(\w+)\s*\{\s*([^,\s]+)\s*,")
_BIB_FIELD_HEAD_RE = re.compile(r"(\w+)\s*=\s*")


def _clean_bib_field(s: str) -> str:
    s = s.strip()
    s = s.replace("\\&", "&").replace("\\%", "%").replace("\\_", "_")
    s = s.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", s).strip()


def _parse_bib_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    i = 0
    while i < len(body):
        m = _BIB_FIELD_HEAD_RE.search(body, i)
        if not m:
            break
        name = m.group(1).lower()
        start = m.end()
        if start >= len(body):
            break
        ch = body[start]
        if ch == "{":
            depth = 1
            j = start + 1
            while j < len(body) and depth > 0:
                if body[j] == "{":
                    depth += 1
                elif body[j] == "}":
                    depth -= 1
                j += 1
            val = body[start + 1 : j - 1]
            i = j
        elif ch == '"':
            j = start + 1
            while j < len(body) and body[j] != '"':
                j += 2 if body[j] == "\\" and j + 1 < len(body) else 1
            val = body[start + 1 : j]
            i = j + 1
        else:
            j = start
            while j < len(body) and body[j] not in ",}\n":
                j += 1
            val = body[start:j]
            i = j
        while i < len(body) and body[i] in ", \t\r\n":
            i += 1
        fields[name] = _clean_bib_field(val)
    return fields


def _short_author(author_str: str) -> str:
    if not author_str:
        return "Anonymous"
    names = [n.strip() for n in re.split(r"\s+and\s+", author_str) if n.strip()]
    if not names:
        return "Anonymous"
    first = names[0]
    if "," in first:
        surname = first.split(",", 1)[0].strip()
    else:
        parts = first.split()
        surname = parts[-1] if parts else first
    surname = re.sub(r"[^A-Za-z'\-]", "", surname) or first
    return f"{surname} et al." if len(names) >= 2 else surname


def _full_authors(author_str: str) -> str:
    """Render the full BibTeX author field with Oxford-comma joining."""
    if not author_str:
        return "Anonymous"
    raw = [n.strip() for n in re.split(r"\s+and\s+", author_str) if n.strip()]
    if not raw:
        return "Anonymous"
    names: list[str] = []
    for n in raw:
        if "," in n:
            last, first = (p.strip() for p in n.split(",", 1))
            names.append(f"{first} {last}".strip() if first else last)
        else:
            names.append(n)
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return ", ".join(names[:-1]) + f", and {names[-1]}"


def _parse_bib(path: Path) -> dict[str, dict]:
    """Return {cite_key: {short_author, title, venue, year, doi}}.

    Balanced-brace parse; tolerant of bare-value years (`year = 2024`) and
    of the auto-generated style emitted by phase05_merge_full_draft.
    """
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8", errors="ignore")
    out: dict[str, dict] = {}
    i = 0
    while i < len(text):
        m = _BIB_ENTRY_RE.search(text, i)
        if not m:
            break
        key = m.group(2)
        start = m.end()
        depth = 1
        j = start
        while j < len(text) and depth > 0:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        body = text[start : j - 1]
        i = j
        fields = _parse_bib_fields(body)
        # Prefer booktitle over journal — for arXiv preprints later accepted
        # at a venue, booktitle holds the venue and journal holds "ArXiv".
        venue = fields.get("booktitle") or fields.get("journal") or ""
        out[key] = {
            "short_author": _short_author(fields.get("author", "")),
            "full_authors": _full_authors(fields.get("author", "")),
            "title": fields.get("title", ""),
            "venue": venue,
            "year": fields.get("year", ""),
            "doi": fields.get("doi", ""),
            "url": fields.get("url", ""),
        }
    return out


class _CitationRegistry:
    """Stateful citation rewriter.

    `rewrite(text)` substitutes every `\\cite*{...}` in `text` and registers
    each cited key (in first-appearance order) so that callers can produce a
    numbered reference list at the end. Unknown keys are silently dropped;
    `\\cite` is treated as `\\citep` (numeric/bracketed).
    """

    def __init__(self, bib: dict[str, dict]):
        self.bib = bib
        self.order: list[str] = []
        self.numbers: dict[str, int] = {}
        self.first_seen_in: dict[str, str] = {}
        self.unknown: set[str] = set()
        self.dropped_inline: int = 0

    def _register(self, key: str, section_id: str | None) -> int | None:
        if key not in self.bib:
            self.unknown.add(key)
            return None
        if key not in self.numbers:
            self.order.append(key)
            self.numbers[key] = len(self.order)
            if section_id is not None:
                self.first_seen_in[key] = section_id
        return self.numbers[key]

    def rewrite(self, text: str, section_id: str | None = None) -> str:
        def parens(match: re.Match) -> str:
            keys = [k.strip() for k in match.group(1).split(",") if k.strip()]
            kept: list[tuple[int, str]] = []
            for k in keys:
                n = self._register(k, section_id)
                if n is not None:
                    kept.append((n, k))
            if not kept:
                self.dropped_inline += 1
                return ""
            if len(kept) == 1:
                n, k = kept[0]
                return f"[[{n}]](#ref-{k})"
            inner = ", ".join(f"[{n}](#ref-{k})" for n, k in kept)
            return f"[{inner}]"

        def textual(match: re.Match) -> str:
            keys = [k.strip() for k in match.group(1).split(",") if k.strip()]
            parts: list[str] = []
            for k in keys:
                n = self._register(k, section_id)
                if n is None:
                    continue
                short = self.bib[k]["short_author"] or k
                parts.append(f"{short} [[{n}]](#ref-{k})")
            if not parts:
                self.dropped_inline += 1
                return ""
            return ", ".join(parts)

        text = re.sub(r"\\citep\{([^}]+)\}", parens, text)
        text = re.sub(r"\\cite\{([^}]+)\}", parens, text)
        text = re.sub(r"\\citet\{([^}]+)\}", textual, text)
        return text


def _rewrite_refs(
    text: str,
    fig_numbers: dict[str, int],
    tab_numbers: dict[str, int],
    language: str = "english",
) -> str:
    """Rewrite `(Figure|Table)?~?\\ref{(fig|tab):X}` to anchor links.

    Unknown labels are stripped; the cleanup pass tightens surrounding
    whitespace afterwards.
    """
    labels = labels_for(language)

    def sub(m: re.Match) -> str:
        kind, lbl = m.group(1), m.group(2)
        if kind == "fig" and lbl in fig_numbers:
            return f"[{labels['figure']} {fig_numbers[lbl]}](#fig-{lbl})"
        if kind == "tab" and lbl in tab_numbers:
            return f"[{labels['table']} {tab_numbers[lbl]}](#tab-{lbl})"
        return ""

    return re.sub(
        r"(?:图|表|Figure|Table|Fig\.?|Tab\.?)?[ ~]?\\ref\{(fig|tab):([\w\-]+)\}",
        sub,
        text,
    )



def _render_references(registry: _CitationRegistry,
                       language: str = "english") -> list[str]:
    if not registry.order:
        return []
    ref_label = labels_for(language)["references"]
    lines = [f"## {ref_label}", ""]
    for key in registry.order:
        n = registry.numbers[key]
        meta = registry.bib.get(key, {})
        authors = meta.get("full_authors") or meta.get("short_author") or key
        title = (meta.get("title") or "").rstrip(".")
        venue = meta.get("venue") or ""
        year = meta.get("year") or ""
        doi = meta.get("doi") or ""
        url = meta.get("url") or ""
        venue_year = ", ".join(p for p in (venue, year) if p)
        parts = [f"[{n}]", f"**{authors}**."]
        if title:
            parts.append(f"{title}.")
        if venue_year:
            parts.append(f"_{venue_year}._")
        if doi:
            parts.append(f"doi:{doi}")
        if url:
            parts.append(f"URL: <{url}>")
        lines.append(f'<a id="ref-{key}"></a>')
        lines.append(" ".join(parts))
        lines.append("")
    return lines


_REF_SCAN_RE = re.compile(r"\\ref\{(fig|tab):([\w\-]+)\}")


def _figure_worklist_items(ws: Workspace) -> list[dict]:
    """The figure metadata, or `[]`. Read for the image path a render mode
    recorded; see `latex_to_markdown.scan_figures` for why that is read
    generically rather than by render mode."""
    path = ws.figures_worklist_path()
    if not path.exists():
        return []
    try:
        return (load_json(path) or {}).get("items", []) or []
    except Exception:  # noqa: BLE001
        return []


def _latex_to_markdown_fallback(ws: Workspace,
                                language: str = "english") -> dict:
    """Best-effort markdown rendering when pdflatex fails.

    Embeds:
      - inline figures (./figures/<basename>, supplied by the bundle copy)
      - markdown tables (or fenced LaTeX block when the column spec is
        anything beyond plain `l c r X`)
      - numbered `\\citep`/`\\cite` and named `\\citet` linked to a final
        numbered References section. Unknown cite keys are silently dropped.

    Returns a dict with the output path plus per-component metrics for the
    status row.
    """
    outline = load_outline(ws.root)
    bib = _parse_bib(ws.citations_bib_path)
    fig_meta = scan_figures(ws.figures_dir, _figure_worklist_items(ws))
    tab_meta = scan_tables(ws.tables_dir)
    registry = _CitationRegistry(bib)

    def caption_filter(section_id: str):
        """Resolve citations inside a caption as the fallback goes.

        The fallback numbers its references streaming, in first-citation
        order, so a caption has to be rewritten at the moment it is placed.
        The native Markdown path does the opposite — it resolves the whole
        document at the end — which is why the renderers take a filter
        rather than owning a registry.
        """
        return lambda text: cleanup_text(registry.rewrite(text, section_id))

    # AI authorship byline — mirror the LaTeX `\author{...}` line emitted by
    # phase05_merge_full_draft so the markdown fallback carries the same
    # provenance stamp the PDF would.
    from branding import review_byline, full_survey
    md_lines = [f"# {(outline.get('survey_title') or outline.get('suggested_title') or outline.get('topic') or 'Survey').strip()}", ""]
    if full_survey(ws.root): md_lines += [f"_{review_byline(language)}_", ""]

    fig_numbers: dict[str, int] = {}
    tab_numbers: dict[str, int] = {}
    placed_figs: set[str] = set()
    placed_tabs: set[str] = set()

    for parent, sec in iter_all_sections(outline):
        sid = sec["section_id"]
        title = sec.get("title", "")
        heading = "## " if parent is None else "### "
        is_abstract = sid == "0" or title.strip().lower() in {"abstract", "摘要"}
        if is_abstract:
            md_lines.append(f"{heading}{title or 'Abstract'}")
        else:
            md_lines.append(f"{heading}{sid} {title}")
        md_lines.append("")

        path = ws.section_drafts_dir / f"{sid}.json"
        if not path.exists():
            continue

        data = load_json(path)
        body_raw = (data.get("body_md") or "").strip()
        if not body_raw:
            continue

        # Assign figure/table numbers by first-mention order.
        for m in _REF_SCAN_RE.finditer(body_raw):
            kind, lbl = m.group(1), m.group(2)
            if kind == "fig" and lbl in fig_meta and lbl not in fig_numbers:
                fig_numbers[lbl] = len(fig_numbers) + 1
            elif kind == "tab" and lbl in tab_meta and lbl not in tab_numbers:
                tab_numbers[lbl] = len(tab_numbers) + 1

        body = _rewrite_refs(body_raw, fig_numbers, tab_numbers, language)
        body = registry.rewrite(body, sid)
        body = rewrite_lists(body)
        body = cleanup_text(body)
        md_lines.append(body)
        md_lines.append("")

        # Place assets first-mentioned in this section, right after the body.
        for m in _REF_SCAN_RE.finditer(body_raw):
            kind, lbl = m.group(1), m.group(2)
            if kind == "fig" and lbl in fig_meta and lbl not in placed_figs:
                placed_figs.add(lbl)
                md_lines.append(
                    render_figure_md(fig_meta[lbl], fig_numbers[lbl],
                                     language, caption_filter(sid))
                )
                md_lines.append("")
            elif kind == "tab" and lbl in tab_meta and lbl not in placed_tabs:
                placed_tabs.add(lbl)
                md_lines.append(
                    render_table_md(tab_meta[lbl], tab_numbers[lbl],
                                    language, caption_filter(sid))
                )
                md_lines.append("")

    # Orphan assets — present on disk but never \ref'd.
    orphan_figs = [l for l in sorted(fig_meta) if l not in placed_figs]
    orphan_tabs = [l for l in sorted(tab_meta) if l not in placed_tabs]
    if orphan_figs or orphan_tabs:
        appendix_label = labels_for(language)["appendix"]
        md_lines.append(f"## {appendix_label}")
        md_lines.append("")
        for lbl in orphan_figs:
            n = fig_numbers.get(lbl) or (len(fig_numbers) + 1)
            fig_numbers[lbl] = n
            md_lines.append(
                render_figure_md(fig_meta[lbl], n, language,
                                 caption_filter("appendix"))
            )
            md_lines.append("")
        for lbl in orphan_tabs:
            n = tab_numbers.get(lbl) or (len(tab_numbers) + 1)
            tab_numbers[lbl] = n
            md_lines.append(
                render_table_md(tab_meta[lbl], n, language,
                                caption_filter("appendix"))
            )
            md_lines.append("")

    md_lines.extend(_render_references(registry, language))

    md_path = ws.survey_md_fallback_path
    # 06_output/ is no longer pre-created by ensure_output_dirs on a compile
    # failure, so materialise it here at the moment we emit the fallback.
    ws.output.mkdir(parents=True, exist_ok=True)
    md_path.write_text("\n".join(md_lines), encoding="utf-8")
    tables_gfm = sum(
        1 for lbl in tab_numbers
        if tab_meta.get(lbl, {}).get("render_mode") == "gfm"
    )
    tables_html = sum(
        1 for lbl in tab_numbers
        if tab_meta.get(lbl, {}).get("render_mode") == "html"
    )
    return {
        "path": str(md_path),
        "figures_embedded": len(fig_numbers),
        "tables_embedded": len(tab_numbers),
        "tables_gfm": tables_gfm,
        "tables_html": tables_html,
        "citations_resolved": len(registry.order),
        "citations_unresolved": sorted(registry.unknown),
        "citations_dropped_inline": registry.dropped_inline,
        "orphan_figures": orphan_figs,
        "orphan_tables": orphan_tabs,
    }


# ----------------------------------------------------------------------------
# The native Markdown path — no compile, no sanitise, one resolution pass
# ----------------------------------------------------------------------------


def _survey_md_path(ws: Workspace) -> Path:
    """The Markdown path's deliverable. Distinct from
    `survey_fallback.md`, which is what the LaTeX path leaves behind when it
    could not produce a PDF — the two must never be confused, because one is
    the artefact the user asked for and the other is an apology."""
    return ws.output / "survey.md"


def _publish_markdown_bundle(ws: Workspace) -> dict:
    """Mirror everything `survey.md` points at into `06_output/`.

    The document embeds images as `./figures/<name>`, so the figures directory
    has to sit next to it or the deliverable is a file full of broken links —
    which is exactly what the verification stage checks for.
    """
    ws.output.mkdir(parents=True, exist_ok=True)
    bundle: dict = {"survey_md": str(_survey_md_path(ws))}

    if ws.citations_bib_path.exists():
        shutil.copyfile(ws.citations_bib_path, ws.survey_citations_bib_path)
        bundle["citations_bib"] = str(ws.survey_citations_bib_path)

    figures_copied = 0
    if ws.figures_dir.exists():
        if ws.survey_figures_dir.exists():
            shutil.rmtree(ws.survey_figures_dir)
        shutil.copytree(ws.figures_dir, ws.survey_figures_dir)
        figures_copied = sum(1 for _ in ws.survey_figures_dir.iterdir())
    bundle["figures_dir"] = str(ws.survey_figures_dir)
    bundle["figures_files"] = figures_copied

    # Tables are already inline in the Markdown. The .tex sources come along
    # anyway, for the same reason survey.tex does on the other path: the
    # deliverable should carry the thing it was built from.
    tables_copied = 0
    if ws.tables_dir.exists():
        if ws.survey_tables_dir.exists():
            shutil.rmtree(ws.survey_tables_dir)
        shutil.copytree(ws.tables_dir, ws.survey_tables_dir)
        tables_copied = sum(1 for _ in ws.survey_tables_dir.iterdir())
    bundle["tables_dir"] = str(ws.survey_tables_dir)
    bundle["tables_files"] = tables_copied
    return bundle


def _publish_markdown(ws: Workspace, spec: dict, language: str,
                      started: float) -> int:
    """Resolve citations into `06_output/survey.md` and publish.

    This is the whole Markdown publish step. There is no compile to fail, so
    there is no fix loop, no `diagnosis` in the status row, and no Markdown
    fallback — the Markdown IS the deliverable.

    Citations resolve against `03_process/references.bib`, the corpus
    bibliography, rather than `05_generation/citations.bib`, which is a
    selection out of it. Reading the source means an entry cannot be missing
    here because the selection step had a bad day; the selection is still
    written, and still published alongside, because that is the bibliography
    scoped to what the document actually cites.
    """
    candidates = [ws.gen / f"full_draft_v{n}.md" for n in (3, 2, 1)]
    source = next((p for p in candidates if p.exists()), None)
    if source is None:
        write_status(ws, "phase07_compile_latex", "FAILED",
                     duration_sec=round(time.time() - started, 2),
                     engine="markdown",
                     language=language,
                     output_format=spec["format"],
                     message="No full_draft_v{1,2,3}.md found; run the merge first.")
        return 2

    entries = citation_formats.parse_bib_file(ws.process / "references.bib")
    bib_source = "03_process/references.bib"
    if not entries:
        entries = citation_formats.parse_bib_file(ws.citations_bib_path)
        bib_source = "05_generation/citations.bib" if entries else "none"

    ws.output.mkdir(parents=True, exist_ok=True)
    from writing_contract import load_outline
    component = ((ws.gen/'_internal/manuscript_contract.json').exists() and
                 not load_outline(ws.root).get('outline_tree'))
    if component:
        # The requested component stays a component. Its citation list is a
        # linked companion, not an unsolicited section appended to its body.
        resolver = citation_formats.CitationResolver(entries, spec['citation_style'], language)
        raw = source.read_text(encoding='utf-8'); resolver.collect(raw)
        rendered = resolver.rewrite(raw).replace('](#ref-', '](references.md#ref-')
        metrics = resolver.metrics()
        (ws.output/'references.md').write_text('\n'.join(resolver.reference_lines())+'\n', encoding='utf-8')
    else:
        rendered, metrics = citation_formats.resolve_document(
            source.read_text(encoding="utf-8"), entries, spec["citation_style"], language)
        (ws.output/'references.md').unlink(missing_ok=True)
    _survey_md_path(ws).write_text(rendered, encoding="utf-8")
    bundle = _publish_markdown_bundle(ws)
    purged = _purge_stale_outputs(ws, language, markdown=True)

    metrics["bibliography_source"] = bib_source
    metrics["bibliography_entries_available"] = len(entries)
    warnings: list[str] = []
    if metrics["citations_unresolved"]:
        warnings.append(
            f"{len(metrics['citations_unresolved'])} cite key(s) had no "
            f"bibliography entry and were dropped from the prose: "
            f"{metrics['citations_unresolved'][:10]}")
    if not entries:
        warnings.append("no bibliography entries available; every citation dropped")

    write_status(
        ws, "phase07_compile_latex",
        "PARTIAL_SUCCESS" if warnings else "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        engine="markdown",
        passes=0,
        language=language,
        output_format=spec["format"],
        engine_overridden_for_chinese=False,
        source=str(source),
        output=str(_survey_md_path(ws)),
        bundle=bundle,
        purged_stale=purged,
        citation_metrics=metrics,
        warnings=warnings[:50],
        errors=[],
    )
    return 0


def _main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--scope", default="deep", choices=["speed", "deep"])
    p.add_argument("--language", default=None, choices=["english", "chinese"])
    p.add_argument("--engine", default="pdflatex", choices=["pdflatex", "xelatex"])
    p.add_argument("--passes", type=int, default=2)
    p.add_argument("--md-only", action="store_true",
                   help="Skip LaTeX compile; emit markdown fallback only.")
    p.add_argument(
        "--emit-fallback-on-failure", action="store_true",
        help="On a fixable compile failure (engine present, verdict "
             "partial_pdf/no_pdf), emit the Markdown fallback + 06_output bundle. "
             "Off by default so the agent's compile fix loop can revise the source "
             "first; the agent passes this flag only after exhausting its fix "
             "attempts. A clean compile always publishes regardless of this flag.")
    args = p.parse_args()

    started = time.time()
    ws = Workspace()
    # Do not create 06_output/ up front — a deferred-fallback compile failure
    # must leave 06_output/ untouched until the fix loop resolves. The clean
    # branch and the fallback writer each create it when they publish.
    ws.ensure_output_dirs(include_output=False)
    log_script_start(ws, "phase07_compile_latex",
                     engine=getattr(args, "engine", None),
                     language=getattr(args, "language", None),
                     skip_compile=getattr(args, "skip_compile", False))

    # Resolve language; chinese forces xelatex regardless of --engine since
    # the phase 5 Chinese preamble uses ctexart, which requires xeCJK font
    # support that pdflatex cannot provide.
    if args.language:
        language = args.language
    elif ws.query_meta_path().exists():
        language = (load_json(ws.query_meta_path()) or {}).get("language", "english")
    else:
        language = "english"
    # The Markdown path leaves before any of the LaTeX machinery below is
    # touched: no engine to look for, no sanitiser to have run, no fallback to
    # defer. It writes no `diagnosis`, which is precisely what tells the
    # agent's compile fix loop there is nothing here to fix.
    spec = read_output_spec(ws.root)
    if spec["format"] == "markdown":
        return _publish_markdown(ws, spec, language, started)

    engine_overridden = False
    if language == "chinese" and args.engine != "xelatex":
        args.engine = "xelatex"
        engine_overridden = True
        log_debug(ws, "phase07_compile_latex", f"engine overridden to xelatex for Chinese (language={language})")

    # Post 2026-05 refactor: phase 7 compiles `full_draft_v3.tex` (the
    # asset-injected output of phase05b). Falls back to v2 / v1 if v3
    # isn't on disk so a partial pipeline run still produces a PDF for
    # smoke-testing.
    if ws.full_draft_v3_path.exists():
        src_path = ws.full_draft_v3_path
    elif ws.full_draft_v2_path.exists():
        src_path = ws.full_draft_v2_path
    elif ws.full_draft_v1_path.exists():
        src_path = ws.full_draft_v1_path
    else:
        write_status(ws, "phase07_compile_latex", "FAILED",
                     duration_sec=round(time.time() - started, 2),
                     message="No full_draft_v{1,2,3}.tex found; run phase 5 first.")
        return 2

    if args.md_only:
        md_info = _latex_to_markdown_fallback(ws, language)
        bundle = _publish_latex_bundle(ws, src_path, language)
        write_status(ws, "phase07_compile_latex", "PARTIAL_SUCCESS",
                     duration_sec=round(time.time() - started, 2),
                     engine="md-only",
                     language=language,
                     output=md_info["path"],
                     bundle=bundle,
                     fallback_metrics=md_info,
                     message="Markdown fallback (md-only mode).")
        return 0

    if not _which(args.engine):
        md_info = _latex_to_markdown_fallback(ws, language)
        bundle = _publish_latex_bundle(ws, src_path, language)
        write_status(ws, "phase07_compile_latex", "PARTIAL_SUCCESS",
                     duration_sec=round(time.time() - started, 2),
                     engine=f"{args.engine}-missing",
                     language=language,
                     engine_overridden_for_chinese=engine_overridden,
                     output=md_info["path"],
                     bundle=bundle,
                     fallback_metrics=md_info,
                     message=f"{args.engine} not on PATH; emitted Markdown fallback.")
        return 0

    # Compile in workspace root so \input{05_generation/...} resolves.
    # Place auxiliary outputs (.aux/.log/.pdf) in 05_generation/ via
    # -output-directory so they don't pollute the workspace root.
    cwd = ws.root
    src_rel = src_path.relative_to(cwd)
    out_dir_rel = ws.gen.relative_to(cwd)
    aux_in_outdir = out_dir_rel / src_rel.stem  # 05_generation/full_draft_v3 (no ext)
    warnings: list[str] = []
    errors: list[str] = []

    # Build a shared env so pdflatex/xelatex find `neurips_2026.sty` (which
    # phase 5 copied into 05_generation/) and bibtex finds citations.bib and
    # the selected vendored .bst (also staged by phase 5)
    # in the same directory.
    tex_env = dict(os.environ)
    for name in ("TEXINPUTS", "BIBINPUTS", "BSTINPUTS"):
        tex_env[name] = os.pathsep.join((str(ws.gen), ".", tex_env.get(name, "")))

    cmd_pdflatex = [
        args.engine,
        "-interaction=nonstopmode",
        "-halt-on-error",
        f"-output-directory={out_dir_rel}",
        str(src_rel),
    ]
    rc, log = _run(cmd_pdflatex, cwd, env=tex_env)
    log_debug(ws, "phase07_compile_latex", f"pass 1 ({args.engine}): rc={rc}")
    if rc != 0:
        errors.append("pdflatex pass 1 failed")
    if _which("bibtex"):
        proc = subprocess.run(
            ["bibtex", str(aux_in_outdir)],
            cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, env=tex_env,
        )
        log_debug(ws, "phase07_compile_latex", f"bibtex: rc={proc.returncode}")
        if proc.returncode != 0:
            warnings.append(f"bibtex returned {proc.returncode} (continuing)")
    else:
        log_debug(ws, "phase07_compile_latex", "bibtex not on PATH")
        warnings.append("bibtex not on PATH — references will be unresolved")
    final_pass_rc = 0
    for i in range(args.passes):
        rc, log = _run(cmd_pdflatex, cwd, env=tex_env)
        final_pass_rc = rc
        if rc != 0 and i == args.passes - 1:
            errors.append(f"final pdflatex pass returned {rc}")

    pdf_src = cwd / out_dir_rel / (src_rel.stem + ".pdf")
    log_path = cwd / out_dir_rel / (src_rel.stem + ".log")
    diagnosis = _diagnose_compile(pdf_src, log_path, final_pass_rc)
    log_debug(ws, "phase07_compile_latex",
              f"compile diagnosis: verdict={diagnosis['verdict']}, fatal_errors={len(diagnosis['fatal_errors'])}, "
              f"emergency_stop={diagnosis['emergency_stop']}, pdf_bytes={diagnosis['pdf_bytes']}")
    errors.extend(diagnosis["fatal_errors"])
    warnings.extend(diagnosis["log_warnings"])

    if diagnosis["verdict"] == "clean":
        # 06_output/ is no longer pre-created by ensure_output_dirs; the clean
        # branch publishes the PDF here, so create it before copying.
        ws.output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf_src, ws.survey_pdf_path)
        bundle = _publish_latex_bundle(ws, src_path, language)
        purged = _purge_stale_outputs(ws, language)
        write_status(
            ws, "phase07_compile_latex",
            "SUCCESS" if not errors else "PARTIAL_SUCCESS",
            duration_sec=round(time.time() - started, 2),
            engine=args.engine, passes=args.passes,
            language=language,
            engine_overridden_for_chinese=engine_overridden,
            source=str(src_path),
            output=str(ws.survey_pdf_path),
            bundle=bundle,
            purged_stale=purged,
            diagnosis=diagnosis,
            warnings=warnings[:50], errors=errors[:50],
        )
        return 0

    # Compile produced no PDF, or a truncated one.
    # A partial PDF (if any) is left at 05_generation/{stem}.pdf for
    # debugging; it is intentionally not copied into 06_output/.
    #
    # Deferred-fallback path: unless --emit-fallback-on-failure was passed,
    # do NOT emit the Markdown fallback or touch 06_output/ yet. The full
    # draft log / diagnosis are left for the agent's compile fix loop to read
    # and revise the source. Only the status JSON is written (with the
    # diagnosis), so the agent can locate the offending span.
    if not args.emit_fallback_on_failure:
        if diagnosis["verdict"] == "partial_pdf":
            defer_msg = (f"{args.engine} produced a partial PDF; Markdown fallback "
                         "deferred pending the compile fix loop.")
        else:
            defer_msg = (f"{args.engine} failed; Markdown fallback deferred pending "
                         "the compile fix loop.")
        write_status(
            ws, "phase07_compile_latex", "PARTIAL_SUCCESS",
            duration_sec=round(time.time() - started, 2),
            engine=args.engine,
            language=language,
            engine_overridden_for_chinese=engine_overridden,
            source=str(src_path),
            diagnosis=diagnosis,
            warnings=warnings[:50],
            errors=errors[:50],
            message=defer_msg,
        )
        return 0

    # --emit-fallback-on-failure: fix loop exhausted (or caller wants the
    # fallback now) → publish the Markdown fallback + bundle into 06_output/.
    md_info = _latex_to_markdown_fallback(ws, language)
    bundle = _publish_latex_bundle(ws, src_path, language)
    if diagnosis["verdict"] == "partial_pdf":
        msg = f"{args.engine} produced a partial PDF; emitted Markdown fallback."
    else:
        msg = f"{args.engine} failed; emitted Markdown fallback."
    write_status(
        ws, "phase07_compile_latex", "PARTIAL_SUCCESS",
        duration_sec=round(time.time() - started, 2),
        engine=args.engine,
        language=language,
        engine_overridden_for_chinese=engine_overridden,
        source=str(src_path),
        output=md_info["path"],
        bundle=bundle,
        fallback_metrics=md_info,
        diagnosis=diagnosis,
        warnings=warnings[:50],
        errors=errors[:50],
        message=msg,
    )
    return 0


def main() -> int:
    sys.path.insert(0, str(_slr_paths.HOME / 'scripts'))
    from manuscript_publication import publish
    result=publish(Workspace().root)
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['status']=='SUCCESS' else 1


if __name__ == "__main__":
    sys.exit(main())
