"""Phase 5 (Step A) — Merge sections (no LLM).

Walks outline_tree and assembles the section drafts into
`{workspace}/05_generation/full_draft_v1.tex`
— or `full_draft_v1.md`, when `04_outline/output_spec.json` says the run is a
Markdown one.

ONE WALK, TWO EMITTERS

`_walk_document()` owns everything that decides WHAT goes where: which section
is the abstract, which one is skipped because it already appeared as the
abstract, which draft belongs to each section, and what order any of it is in.
`_emit_latex()` and
`_emit_markdown()` own only HOW it is written down. Forking the walk instead
would mean that a change to the ordering rules — and the abstract handling
alone has one rule for English and a different one for Chinese — has to be made
twice and stays right only until someone makes it once.

The v1 stage intentionally does NOT emit `\\input{05_generation/tables/...}`
or `\\input{05_generation/figures/...}` lines — that is the job of
`phase05b_insert_assets.py`, which runs against the agent-refined v2.
Splitting the merge in two lets the coherency-refinement skill operate on
a document free of asset placeholders. The Markdown path splits at the same
seam for the same reason, with rendered asset blocks in place of `\\input{}`.
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
import time
from pathlib import Path

# Reuse the shared Workspace / cite-key / outline helpers that live with
# the rest of the generation pipeline. parents[4] resolves to the repo
# root from this skill tree.
PROJECT_ROOT = Path(__file__).resolve().parents[4]
pass
from writing_contract import load_outline
from _utils import (  # noqa: E402
    Workspace,
    fix_broken_refs,
    iter_all_sections,
    load_json,
    log_debug,
    log_script_start,
    section_label,
    write_status,
)
from output_spec import read_output_spec  # noqa: E402
from citation_styles import CITATION_STYLES, style_asset  # noqa: E402

# Markdown counterparts of the versioned LaTeX drafts. Kept here rather than on
# `Workspace` because only the Markdown branch of generation knows they exist;
# every other consumer asks the output spec first.
FULL_DRAFT_V1_MD = "full_draft_v1.md"

from branding import review_byline, full_survey

MD_ABSTRACT_HEADING = {"chinese": "摘要", "english": "Abstract"}


# English mode is built on the NeurIPS 2026 style file (`neurips_2026.sty`),
# loaded with the `preprint` option so the document is non-anonymized and the
# `lineno` package is NOT loaded (lineno is known to clash with tikz/forest).
# The .sty file ships with this skill at
# `assets/templates/neurips/neurips_2026.sty`; phase 5 copies it into
# `{workspace}/05_generation/` next to `full_draft_v1.tex` so pdflatex can
# resolve `\usepackage{neurips_2026}` (phase 7 also prepends the same
# directory to TEXINPUTS as belt-and-suspenders).
#
# Was `neurips_2025.sty` in `assets/` until the 2026 kit replaced it. The two
# are drop-in compatible for this preamble -- identical page metrics, same
# `preprint` option, 2026 only adds three font-size definitions and three
# submission-track options -- so the migration was a rename. If a later kit is
# not drop-in, that is the moment to wire `output_spec["template"]` through
# rather than to rename again.
NEURIPS_STY_FILENAME = "neurips_2026.sty"
NEURIPS_TEMPLATE_DIR = _slr_paths.HOME / "assets" / "templates" / "neurips"

PREAMBLE_EN = r"""\documentclass{article}
\PassOptionsToPackage{hidelinks}{hyperref}
\PassOptionsToPackage{numbers,sort}{natbib}
\usepackage[preprint]{neurips_2026}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{url}
\usepackage{booktabs}
\usepackage{amsfonts}
\usepackage{amsmath,amssymb}
\usepackage{bm}
\usepackage{nicefrac}
\usepackage{microtype}
\usepackage{xcolor}
\usepackage{graphicx}
\usepackage{array}
\usepackage{tabularx}
\usepackage{longtable}
\usepackage{hyperref}
% Figure/table caption label separator: render "Figure 1. caption" /
% "Table 1. caption" with a period after the number instead of the default
% colon. Load after the template and hyperlink package.
\usepackage{caption}
\captionsetup{labelsep=period}
% Forest / TikZ for LaTeX-native taxonomy diagrams emitted by the
% survey-figure-rendering skill. Requires `forest` from TeX Live (install
% via `tlmgr install forest pgf` if pdflatex reports it missing). If forest
% is unavailable on this machine, Phase 7 compile will fail and
% phase07_compile_latex.py falls back to the markdown export — that is the
% contracted degradation path.
\usepackage[edges]{forest}
\usetikzlibrary{shapes.geometric,arrows.meta}
% Lightweight \todo replacement so we do not depend on todonotes.sty
\providecommand{\todo}[2][]{{\color{red}\textbf{[TODO #1: #2]}}}
\bibliographystyle{unsrtnat_scholarseed}
"""

# Chinese preamble: built on `ctexart` (CTeX) which auto-loads xeCJK,
# configures CJK fonts, and localises \section / \abstract headings. Must
# be compiled with xelatex — phase07_compile_latex.py auto-promotes the
# engine when language=chinese is recorded in query_meta.json.
PREAMBLE_ZH = r"""\documentclass[UTF8,11pt,a4paper,fontset=fandol]{ctexart}
\usepackage[a4paper,margin=2.4cm]{geometry}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{array}
\usepackage{tabularx}
\usepackage{longtable}
\usepackage{amsmath,amssymb}
\usepackage{bm}
\usepackage[colorlinks=true,urlcolor=blue,linkcolor=black,citecolor=black]{hyperref}
\usepackage[numbers,sort]{natbib}
\usepackage{xcolor}
% 图/表标题分隔符：编号后用句点而非默认冒号，渲染为「图1. 标题」「表1. 标题」。
% 在 hyperref 之后加载，确保覆盖生效。
\usepackage{caption}
\captionsetup{labelsep=period}
\usepackage[edges]{forest}
\usetikzlibrary{shapes.geometric,arrows.meta}
\providecommand{\todo}[2][]{{\color{red}\textbf{[TODO #1: #2]}}}
\bibliographystyle{unsrtnat_scholarseed}
% ctexart 默认 \pagestyle{headings}（节标题作运行页眉 + 右上角页码），
% 而 \maketitle 又把首页强制成 plain（底部居中页码），导致首页与后续页页码
% 位置不一致。统一改为 plain：所有页页码均居中放在页面底部，且不显示页眉。
\pagestyle{plain}
"""


def _citation_preamble(language: str, spec: dict) -> str:
    """Inject the resolved citation style into the language preamble."""
    base = PREAMBLE_ZH if language == "chinese" else PREAMBLE_EN
    base = base.replace("numbers,sort", spec["natbib_options"])
    return base.replace(
        "\\bibliographystyle{unsrtnat_scholarseed}",
        f"\\bibliographystyle{{{spec['bibliography_style']}}}",
    )


def _section_body(refined_dir: Path, sid: str) -> str:
    """Return body_md for the given section, or "" if the file is missing."""
    path = refined_dir / f"{sid}.json"
    if not path.exists():
        return ""
    data = load_json(path)
    return (data.get("body_md") or "").strip()


def _walk_document(ws: Workspace, outline: dict, language: str) -> dict:
    """Resolve the whole document's structure and bodies, once, dialect-free.

    Returns::

        {"survey_title": str,
         "abstract": {"section_id", "title", "body"} | None,
         "sections": [{"section_id", "title", "body",
                       "subsections": [{"section_id", "title", "body"}]}]}

    Two things here look like duplication and are not. The abstract is found by
    `section_id == "0"` in Chinese and by the literal title "abstract" in
    English, because those are two different upstream contracts and the English
    one is frozen. And an English top-level "Abstract" that HAS subsections is
    emitted as an ordinary numbered section as well as an abstract — that is the
    shipped behaviour, it is what existing workspaces contain, and quietly
    "fixing" it here would drop a section out of documents that already exist.
    """
    drafts_dir = ws.section_drafts_dir

    def body_of(sid: str) -> str:
        return _section_body(drafts_dir, sid)

    # Title source of truth: upstream `survey_title` (post-2026-05 contract).
    # Fall back to legacy `suggested_title`, then `topic`, then a placeholder
    # — but the upstream Outline module is expected to always supply
    # `survey_title`, so the fallbacks only fire on legacy mock workspaces.
    survey_title = (
        (outline.get("survey_title") or "").strip()
        or (outline.get("suggested_title") or "").strip()
        or (outline.get("topic") or "").strip()
        or "Survey"
    )

    abstract: dict | None = None
    whole_manuscript = (ws.gen/'_internal/manuscript_contract.json').exists()
    if whole_manuscript:
        # Numeric identity is not a genre instruction. A Chinese component
        # starting at ID 0 must not become an abstract merely due to its ID.
        front = next((s for s in outline.get('outline_tree', [])
                      if str(s.get('title','')).strip().casefold() in ('abstract','摘要')
                      and not s.get('subsections')), None)
        if front and body_of(front['section_id']):
            abstract = {'section_id':front['section_id'], 'title':front['title'],
                        'body':body_of(front['section_id'])}
    elif language == "chinese":
        front = next(
            (s for s in outline.get("outline_tree", [])
             if str(s.get("section_id") or "").strip() == "0"),
            None,
        )
        if front:
            front_body = body_of(front["section_id"])
            if front_body:
                abstract = {
                    "section_id": front["section_id"],
                    "title": front.get("title") or "",
                    "body": front_body,
                }
    else:
        for parent, sec in iter_all_sections(outline):
            if (sec.get("title") or "").strip().lower() == "abstract" and parent is None:
                abstract_body = body_of(sec["section_id"])
                if abstract_body:
                    abstract = {
                        "section_id": sec["section_id"],
                        "title": sec.get("title") or "",
                        "body": abstract_body,
                    }
                break

    sections: list[dict] = []
    for sec in outline.get("outline_tree", []):
        sid = sec.get("section_id") or ""
        title_l1 = sec.get("title") or ""
        # Skip the front-matter section so it isn't re-emitted as a numbered
        # section. English keys off the title (legacy, frozen); Chinese keys
        # off section_id == "0" (new contract).
        if whole_manuscript:
            if abstract and sid == abstract['section_id']:
                continue
        elif language == "chinese":
            if str(sid).strip() == "0":
                continue
        else:
            if title_l1.strip().lower() == "abstract" and not sec.get("subsections"):
                continue

        node = {"section_id": sid, "title": title_l1, "body": "", "subsections": []}
        l1_body = body_of(sid)
        if l1_body and sec.get("subsections"):
            # A draft filed under the L1's own id, for a section that HAS
            # subsections, is a whole-section draft: one `legacy section author`
            # wrote the section including its `\subsection{}` / `###` headings
            # and their labels. Emitting our own headings around it would double
            # every one of them.
            #
            # Deliberately keyed off the file rather than a flag, so a workspace
            # drafted per-leaf still merges exactly as before -- there is no L1
            # draft to find, and the loop below runs unchanged.
            node["body"] = l1_body
        elif not sec.get("subsections"):
            node["body"] = l1_body
        else:
            for sub in sec["subsections"]:
                sub_sid = sub["section_id"]
                sub_body = body_of(sub_sid)
                if not sub_body:
                    log_debug(ws, "phase05_merge_full_draft",
                              f"section {sub_sid} has no draft body, "
                              f"inserting TODO placeholder")
                node["subsections"].append({
                    "section_id": sub_sid,
                    "title": sub.get("title", ""),
                    "body": sub_body,
                })
        sections.append(node)

    return {"survey_title": survey_title, "abstract": abstract, "sections": sections}


def _emit_latex(ws: Workspace, outline: dict, language: str, spec: dict) -> None:
    doc = _walk_document(ws, outline, language)
    survey_title = doc["survey_title"]

    body_lines: list[str] = []

    preamble = _citation_preamble(language, spec)
    author_line = r'\author{' + review_byline(language, latex=True) + '}'

    # English mode depends on the NeurIPS style file. Copy it from the
    # skill's `assets/templates/neurips/` directory into the workspace's
    # 05_generation/ so pdflatex resolves \usepackage{neurips_2026} regardless
    # of where the build is run. Chinese mode uses ctexart and does not need
    # this.
    if language != "chinese":
        src = NEURIPS_TEMPLATE_DIR / NEURIPS_STY_FILENAME
        if not src.exists():
            raise FileNotFoundError(
                f"NeurIPS style file missing at {src}. "
                f"Expected to ship inside the survey-merge-draft skill assets."
            )
        shutil.copyfile(src, ws.gen / NEURIPS_STY_FILENAME)

    style_id = spec["citation_style"]
    registered = CITATION_STYLES[style_id]
    if spec["bibliography_style"] != registered["bst"]:
        raise ValueError(
            f"output_spec bibliography_style={spec['bibliography_style']!r} does not "
            f"match citation_style={style_id!r} ({registered['bst']!r}); regenerate "
            "the spec with ./scripts/slr templates cite"
        )
    bst_src = style_asset(style_id)
    if not bst_src.exists():
        raise FileNotFoundError(
            f"Citation style asset missing at {bst_src}; run ./scripts/slr templates check."
        )
    shutil.copyfile(bst_src, ws.gen / f"{registered['bst']}.bst")

    body_lines.append(preamble)
    body_lines.append("")
    body_lines.append(f"\\title{{{survey_title}}}")
    if full_survey(ws.root):
        body_lines.append(author_line)
    body_lines.append("\\date{\\today}")
    body_lines.append("\\begin{document}")
    body_lines.append("\\maketitle")

    abstract = doc["abstract"]
    if abstract:
        # Chinese: emitted as a native ctexart \begin{abstract} envelope, whose
        # environment auto-prints a centred "摘要" heading (\abstractname); a
        # \phantomsection + \addcontentsline keeps it in the ToC (the abstract
        # environment does not list itself). No \label.
        if language == "chinese":
            body_lines.append("")
            body_lines.append("\\phantomsection")
            body_lines.append(
                f"\\addcontentsline{{toc}}{{section}}{{{abstract['title']}}}")
        else:
            body_lines.append("\\phantomsection")
            body_lines.append("\\addcontentsline{toc}{section}{Abstract}")
        if (ws.gen/"_internal/manuscript_contract.json").exists():
            body_lines.append("\\renewcommand{\\abstractname}{" + abstract["title"] + "}")
        body_lines.append("\\begin{abstract}")
        body_lines.append(abstract["body"])
        body_lines.append("\\end{abstract}")

    for sec in doc["sections"]:
        body_lines.append("")
        body_lines.append(f"\\section{{{sec['title']}}}")
        body_lines.append(f"\\label{{{section_label(sec['section_id'])}}}")

        if not sec["subsections"]:
            if sec["body"]:
                body_lines.append("")
                body_lines.append(sec["body"])
        else:
            for sub in sec["subsections"]:
                body_lines.append("")
                body_lines.append(f"\\subsection{{{sub['title']}}}")
                body_lines.append(f"\\label{{{section_label(sub['section_id'])}}}")
                if not sub["body"]:
                    body_lines.append(
                        f"\\todo[inline]{{Section §{sub['section_id']} draft missing.}}")
                else:
                    body_lines.append("")
                    body_lines.append(sub["body"])

    # NOTE: `\input{05_generation/tables/...}` and `\input{05_generation/figures/...}`
    # lines are intentionally NOT emitted in v1. They are injected later by
    # `phase05b_insert_assets.py` against the agent-refined `full_draft_v2.tex`,
    # so the refinement step (the LLM rewriting the prose) operates on a
    # document free of asset placeholders.

    body_lines.append("")
    body_lines.append("\\clearpage")
    body_lines.append("\\phantomsection")
    body_lines.append("\\addcontentsline{toc}{section}{\\refname}")
    body_lines.append("\\bibliography{citations}")
    body_lines.append("\\end{document}")

    full_tex = "\n".join(body_lines)
    full_tex = fix_broken_refs(full_tex)
    ws.full_draft_v1_path.write_text(full_tex, encoding="utf-8")


def _emit_markdown(ws: Workspace, outline: dict, language: str) -> None:
    """Write `full_draft_v1.md` from the same walk the LaTeX emitter uses.

    Headings carry their outline number (`## 2 Retrieval`, `### 2.1 Sparse`)
    because Markdown has no counters. That number is not decoration: it is what
    a `§2.1` cross-reference resolves to, and what the verification stage reads
    back out of the finished file when it counts citations per section.

    `\\cite{}` and `\\ref{}` are left exactly as the drafters wrote them.
    Citations are resolved in the publish phase, asset references in the asset
    phase — see the module docstring of each. A document that resolved them
    here would have to be re-parsed by both.
    """
    doc = _walk_document(ws, outline, language)
    byline = review_byline(language)

    lines: list[str] = [f"# {doc['survey_title']}", ""]
    if full_survey(ws.root):
        lines += [f"_{byline}_", ""]

    abstract = doc["abstract"]
    if abstract:
        heading = (abstract["title"].strip()
                   or MD_ABSTRACT_HEADING.get(language, MD_ABSTRACT_HEADING["english"]))
        lines += [f"## {heading}", "", abstract["body"].strip(), ""]

    for sec in doc["sections"]:
        lines += [f"## {sec['section_id']} {sec['title']}".rstrip(), ""]
        if not sec["subsections"]:
            if sec["body"]:
                body = sec["body"].strip()
                if (ws.gen / "_internal/manuscript_contract.json").exists():
                    planned = next(s for s in outline['outline_tree'] if s['section_id']==sec['section_id'])
                    for sub in planned.get('subsections',[]):
                        body = re.sub(r'(?m)^###\s+'+re.escape(sub['title'])+r'\s*$',
                                      lambda m: '### '+sub['section_id']+' '+sub['title'], body)
                lines += [body, ""]
        else:
            for sub in sec["subsections"]:
                lines += [f"### {sub['section_id']} {sub['title']}".rstrip(), ""]
                if sub["body"]:
                    lines += [sub["body"].strip(), ""]
                else:
                    lines += [f"_Section §{sub['section_id']} draft missing._", ""]

    text = fix_broken_refs("\n".join(lines))
    (ws.gen / FULL_DRAFT_V1_MD).write_text(text.rstrip() + "\n", encoding="utf-8")


def main() -> int:
    p = argparse.ArgumentParser()
    # `--scope` is retained so the status row records which mode the run
    # belongs to (downstream phases still consult scope for thresholds and
    # length budgets), but the merged-draft format itself is no longer
    # scope-dependent — both modes emit LaTeX.
    p.add_argument("--scope", default="speed", choices=["speed", "deep"])
    # `--language` defaults to reading `query_meta.json`. Override only for
    # debugging / tests; production callers should let it auto-resolve.
    p.add_argument("--language", default=None, choices=["english", "chinese"])
    # `--stage` is informational. `v1` is the only emit mode this script
    # supports after the 2026-05 refactor; phase05b_insert_assets.py owns
    # the v3 emit. The flag is accepted so the orchestrator can pass it for
    # symmetry with phase05b without conditional logic.
    p.add_argument("--stage", default="v1", choices=["v1"])
    args = p.parse_args()

    started = time.time()
    ws = Workspace()
    ws.ensure_output_dirs()
    log_script_start(ws, "phase05_merge_full_draft", stage=args.stage, scope=args.scope)

    outline = load_outline(ws.root)

    if args.language:
        language = args.language
    elif ws.query_meta_path().exists():
        language = (load_json(ws.query_meta_path()) or {}).get("language", "english")
    else:
        language = "english"

    spec = read_output_spec(ws.root)
    if spec["format"] == "markdown":
        _emit_markdown(ws, outline, language)
        output_path = ws.gen / FULL_DRAFT_V1_MD
        output_kind = "markdown"
    else:
        _emit_latex(ws, outline, language, spec)
        output_path = ws.full_draft_v1_path
        output_kind = "latex"

    write_status(
        ws,
        "phase05_merge_full_draft",
        "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        scope=args.scope,
        language=language,
        stage=args.stage,
        output_kind=output_kind,
        output_format=spec["format"],
        output_spec_source=spec["spec_source"],
        output_spec_error=spec["spec_error"],
        output=str(output_path),
        full_draft_v1=str(output_path),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
