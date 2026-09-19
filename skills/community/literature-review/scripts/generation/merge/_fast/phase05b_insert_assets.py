"""Insert prepared figures/tables and bibliography into publication source.

Current manuscript publication supplies accepted full-manuscript source and uses
--no-llm-scrub. Legacy v2 selection and optional cleanup remain for explicit older
callers; they are not a second refinement stage of the current workflow."""
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
import asyncio
import re
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
pass
from writing_contract import load_outline
from _utils import (  # noqa: E402
    LLMIOLogger,
    Workspace,
    chat_with_logging,
    load_json,
    log_script_start,
    normalize_latex_commands,
    parse_bibtex_entries,
    render_bibtex_entry,
    section_label,
    write_status,
)

# LLM machinery for dropped-figure reference smoothing. This is the only place
# generation calls the gateway directly; it reuses the `refinement_full` stage
# config because the edit it makes is the same kind of work the refiner agent
# does in the compatibility path — a light, low-temperature prose rewrite.
pass
pass
from light_llm import create_llm as _create_llm_raw  # noqa: E402
from load_model_config import load_stage_config as _load_stage_config  # noqa: E402
from output_spec import read_output_spec  # noqa: E402
from latex_to_markdown import (  # noqa: E402
    labels_for,
    render_figure_md,
    render_table_md,
    scan_figures,
    scan_tables,
)

# Markdown counterparts of the versioned drafts, mirroring
# phase05_merge_full_draft.FULL_DRAFT_V1_MD.
FULL_DRAFT_V1_MD = "full_draft_v1.md"
FULL_DRAFT_V2_MD = "full_draft_v2.md"
FULL_DRAFT_V3_MD = "full_draft_v3.md"


_LABEL_RE = re.compile(r"\\label\{(sec:s[^}]+)\}")
_LABEL_IN_ASSET_RE = re.compile(r"\\label\{([^}]+)\}")

# Reference commands recognised when locating the first prose mention of
# an asset. Order matters within the alternation: longer / case-distinct
# variants come first so they are tried before the bare ``ref``.
_REF_CMDS = "(?:autoref|pageref|nameref|Autoref|Cref|cref|eqref|ref)"

# Boundary used by the no-ref-found fallback: the position just before
# the next sectioning marker. Lookahead so ``start()`` is the index of
# the ``\\`` of the next ``\\section`` / ``\\subsection`` /
# ``\\bibliography`` / ``\\end{document}``.
_BOUNDARY_RE = re.compile(
    r"(?=\\(?:section|subsection|bibliography)\b)"
    r"|(?=\\end\{document\})"
)

# Single-pass tokeniser used to walk forward from a ``\\ref{}`` position
# in search of the paragraph break (or enclosing-environment exit) where
# the asset should be spliced.
_TOKEN_RE = re.compile(
    r"\\begin\{([^}]+)\}"                            # 1: begin env name
    r"|\\end\{([^}]+)\}"                              # 2: end env name
    r"|(\\(?:section|subsection|bibliography)\b)"     # 3: sectioning
    r"|(\n[ \t]*\n)"                                  # 4: blank line
)

# Line-based helpers used by the post-injection anti-adjacency pass.
_INPUT_LINE_RE = re.compile(
    r"^\s*\\input\{05_generation/(?:tables|figures)/[^}]+\.tex\}\s*$"
)
_LABEL_LINE_RE = re.compile(r"\\label\{(sec:s[^}]+)\}")
_SECTIONING_LINE_RE = re.compile(
    r"\\(?:section|subsection|bibliography\b|end\{document\})"
)
_ASSET_ID_RE = re.compile(r"05_generation/(?:tables|figures)/([^.}]+)\.tex")


# ---------------------------------------------------------------------------
# Dropped-figure reference scrubbing
# ---------------------------------------------------------------------------
# When an image fails to generate, write_latex.py drops the figure's .tex
# entirely (no placeholder). Any prose reference to that figure's label would
# then dangle, so we strip it here BEFORE injection:
#   Tier 1 (regex)  — parenthetical / aside mentions are deleted in place.
#   Tier 2 (LLM)    — paragraphs with a surviving subject-position mention are
#                     rewritten by the same LLM the refinement stage uses.
#   Fallback        — if the LLM is unavailable or returns an unsafe edit
#                     (drops a citation, or leaves the dropped ref), the whole
#                     sentence carrying the reference is deleted deterministically.
#
# Tier 2 is optional in both directions. It is skipped when the `refinement_full`
# stage is absent from the model config — the agentic pipeline replaces that
# scripted step with a subagent and removes the stage, and this scrub is its only
# other user — and it is skipped on demand via `--no-llm-scrub`, which is what
# the agentic publish stage passes to keep itself free of API calls. Either way
# the tiers above and below still run, so the output is always ref-free; it is
# only the prose smoothing that is lost.

_CITE_KEY_RE = re.compile(r"\\cite[tp]?\*?\{([^}]+)\}")
_FENCE_HEAD_RE = re.compile(r"^```(?:latex|tex)?\s*\n?", re.IGNORECASE)
_FENCE_TAIL_RE = re.compile(r"\n?```\s*$")


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = _FENCE_HEAD_RE.sub("", text, count=1)
        text = _FENCE_TAIL_RE.sub("", text, count=1)
    return text.strip()


def _create_scrub_llm():
    """Create an LLM client using the refinement stage's config verbatim,
    or return None when that stage is not configured.

    An absent `refinement_full` stage is a deployment state, not a fault: the
    agentic pipeline runs refinement as a subagent and drops the stage from
    config/model_config.<profile>.json, leaving this scrub as its only would-be
    user. Returning None sends the caller to the deterministic tiers instead of
    aborting an otherwise healthy publish over a cosmetic rewrite. A stage that
    IS configured behaves exactly as before, including raising out of
    _create_llm_raw on a broken provider entry.
    """
    scfg = _load_stage_config("refinement_full")
    if not scfg:
        return None
    return _create_llm_raw(
        scfg.get("provider"),
        model=scfg.get("model"),
        base_url=scfg.get("base_url"),
        timeout=scfg.get("timeout", 300.0),
        default_temperature=scfg.get("temperature", 0.2),
        default_max_tokens=scfg.get("max_tokens", 128000),
        thinking=scfg.get("thinking", False),
        max_retries=0,
    )


def _dropped_figure_labels(ws: Workspace) -> list[str]:
    """Labels of figures that were NOT materialised on disk.

    A figure is 'dropped' iff its ``{figure_id}.tex`` is absent from
    ``figures/`` — exactly the condition write_latex.py enforces for an
    unrenderable (failed-image / empty-body) figure. Reading the worklist
    gives us the label even though the .tex (which also held it) is gone.
    """
    wl = ws.figures_worklist_path()
    if not wl.exists():
        return []
    try:
        items = (load_json(wl) or {}).get("items", [])
    except Exception:  # noqa: BLE001
        return []
    out: list[str] = []
    for it in items:
        fid = it.get("figure_id")
        label = it.get("label")
        if not fid or not label:
            continue
        if not (ws.figures_dir / f"{fid}.tex").exists():
            out.append(label)
    return out


def _dropped_ref_token_re(labels: list[str]) -> re.Pattern:
    """Match an optional ``Figure``/``Fig.``/``图`` carrier plus a reference
    command pointing at any dropped label."""
    alt = "|".join(re.escape(lbl) for lbl in labels)
    return re.compile(
        r"(?:(?:Figures?|Figs?\.?|图)\s*~?\s*)?"
        rf"\\{_REF_CMDS}\{{(?:{alt})\}}",
        re.IGNORECASE,
    )


def _regex_pre_scrub(text: str, labels: list[str]) -> str:
    """Tier 1: delete parenthetical asides that point at a dropped figure.

    Only the unambiguously sentence-safe case is handled here — a reference
    sitting inside its own parentheses, optionally behind 'see'/'cf.'/etc.
    Removing it leaves the surrounding sentence grammatical. In-prose mentions
    (subject position, 'as shown in …' lead-ins) are intentionally left for the
    LLM tier, which can rewrite them fluently; the sentence-delete fallback
    handles them when the LLM is unavailable.
    """
    alt = "|".join(re.escape(lbl) for lbl in labels)
    ref = rf"\\{_REF_CMDS}\{{(?:{alt})\}}"
    carrier = r"(?:Figures?|Figs?\.?|图)\s*~?\s*"
    # "(see Fig.~\ref{L})", "(\autoref{L})", " (Figure~\ref{L})"
    paren = re.compile(
        r"\s*\((?:see\s+|cf\.?\s+|e\.g\.,?\s+|i\.e\.,?\s+)?"
        rf"(?:{carrier})?(?:{ref})\s*\)",
        re.IGNORECASE,
    )
    return paren.sub("", text)


def _regex_sentence_delete(paragraph: str, token_re: re.Pattern) -> str:
    """Fallback: drop whole sentences that still carry a dropped-figure ref."""
    sentences = re.split(r"(?<=[.!?])\s+", paragraph)
    kept = [s for s in sentences if not token_re.search(s)]
    return " ".join(kept).strip()


def _cleanup_after_scrub(text: str) -> str:
    """Tidy artefacts left by inline deletions, without touching paragraph
    structure beyond collapsing runs of blank lines."""
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"[ \t]+([.,;:])", r"\1", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"[ \t]+\)", ")", text)
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def _cite_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for m in _CITE_KEY_RE.finditer(text):
        for k in m.group(1).split(","):
            k = k.strip()
            if k:
                keys.add(k)
    return keys


def _scrub_output_valid(original: str, rewritten: str, token_re: re.Pattern) -> bool:
    """The LLM rewrite is accepted only if it removed every dropped-figure ref
    and preserved every citation key the original paragraph carried."""
    if not rewritten or not rewritten.strip():
        return False
    if token_re.search(rewritten):
        return False
    return _cite_keys(original).issubset(_cite_keys(rewritten))


def _build_scrub_messages(paragraph: str, labels: list[str]) -> list[dict]:
    label_list = ", ".join(labels)
    system = (
        "You are editing a single LaTeX paragraph from an academic survey. One "
        "or more figures it references could not be generated and have been "
        "removed from the document. Rewrite the paragraph so it no longer refers "
        "to those figures.\n"
        "Rules:\n"
        "- Remove every \\ref/\\autoref/\\Cref/etc. to the removed figure "
        "labels, together with any carrier word like 'Figure~' that introduced "
        "them.\n"
        "- If a whole sentence exists only to point at a removed figure, delete "
        "that sentence; otherwise rewrite the sentence so it reads naturally.\n"
        "- Preserve ALL other content: every \\cite/\\citet/\\citep, every other "
        "\\ref/\\label, all math, and the remaining meaning, unchanged.\n"
        "- Output ONLY the rewritten LaTeX paragraph. No code fences, no "
        "commentary, no preamble."
    )
    user = f"Removed figure labels: {label_list}\n\nParagraph:\n{paragraph}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _scrub_dropped_figure_refs(
    ws: Workspace, text: str, labels: list[str], use_llm: bool = True
) -> tuple[str, dict]:
    """Remove all prose references to dropped figures. Returns (text, info).

    ``use_llm=False`` forces the deterministic tiers (the ``--no-llm-scrub``
    flag). The same path is taken automatically when `refinement_full` is not
    configured; the two cases are told apart by ``info["llm_skipped"]``.
    """
    info: dict = {
        "dropped_labels": labels,
        "refs_total": 0,
        "tier1_removed": 0,
        "paragraphs_rewritten": 0,
        "llm_smoothed": 0,
        "regex_fallback": 0,
        "llm_used": False,
        "llm_error": None,
        # Why tier 2 did not run, when it did not. Stays None both when the LLM
        # ran and when it was tried and failed — that stays `llm_error`.
        "llm_skipped": None,
    }
    if not labels:
        return text, info

    token_re = _dropped_ref_token_re(labels)
    info["refs_total"] = len(token_re.findall(text))

    text = _regex_pre_scrub(text, labels)
    remaining = len(token_re.findall(text))
    info["tier1_removed"] = info["refs_total"] - remaining
    if remaining == 0:
        return _cleanup_after_scrub(text), info

    # Paragraphs still carrying a dropped ref → LLM smoothing (with fallback).
    parts = re.split(r"(\n[ \t]*\n)", text)
    targets = [i for i in range(0, len(parts), 2) if token_re.search(parts[i])]
    info["paragraphs_rewritten"] = len(targets)

    llm = None
    if not use_llm:
        info["llm_skipped"] = "--no-llm-scrub"
    else:
        try:
            llm = _create_scrub_llm()
            if llm is None:
                info["llm_skipped"] = (
                    "stage 'refinement_full' is not configured in "
                    "config/model_config.<profile>.json"
                )
            else:
                info["llm_used"] = True
        except Exception as exc:  # noqa: BLE001
            info["llm_error"] = f"init: {type(exc).__name__}: {exc}"

    if llm is not None:
        io_logger = LLMIOLogger(ws.gen / "figure_ref_scrub_llm_io.jsonl")

        async def _run() -> None:
            for i in targets:
                para = parts[i]
                rewritten: str | None = None
                try:
                    out = await chat_with_logging(
                        llm,
                        _build_scrub_messages(para, labels),
                        item_id=f"para_{i}",
                        io_logger=io_logger,
                        # Matches the deep tree, which streams this rewrite.
                        stream=True,
                        phase="figure_ref_scrub",
                    )
                    out = _strip_fences(out or "")
                    if _scrub_output_valid(para, out, token_re):
                        rewritten = out
                except Exception as exc:  # noqa: BLE001
                    if info["llm_error"] is None:
                        info["llm_error"] = f"chat: {type(exc).__name__}: {exc}"
                if rewritten is not None:
                    parts[i] = rewritten
                    info["llm_smoothed"] += 1
                else:
                    parts[i] = _regex_sentence_delete(para, token_re)
                    info["regex_fallback"] += 1

        asyncio.run(_run())
    else:
        for i in targets:
            parts[i] = _regex_sentence_delete(parts[i], token_re)
            info["regex_fallback"] += 1

    return _cleanup_after_scrub("".join(parts)), info


def _asset_label(tex_path: Path) -> str | None:
    """Return the LaTeX label declared inside ``tex_path``, or ``None``
    when the file is unreadable or has no ``\\label{}``."""
    try:
        text = tex_path.read_text(encoding="utf-8")
    except OSError:
        return None
    m = _LABEL_IN_ASSET_RE.search(text)
    return m.group(1) if m else None


def _first_ref_pos(text: str, label: str) -> int | None:
    """Return the start offset of the first ``\\ref{<label>}`` (or
    alias) in ``text``, or ``None`` if no such reference exists."""
    pat = re.compile(rf"\\{_REF_CMDS}\{{{re.escape(label)}\}}")
    m = pat.search(text)
    return m.start() if m else None


def _insertion_point_for(text: str, ref_pos: int) -> int:
    """Walk forward from ``ref_pos`` and return the offset where the
    asset's ``\\input{}`` line should be spliced.

    The walker tracks LaTeX environment depth so that:

      * ``\\begin{X}``        → depth += 1
      * ``\\end{X}``  (depth>0) → depth -= 1
      * ``\\end{X}``  (depth==0) → the ref was inside env X; restart the
        scan from just after this ``\\end{X}`` (depth resets to 0)
      * blank line at depth 0 → that paragraph ends; insert just before
        the blank
      * ``\\section`` / ``\\subsection`` / ``\\bibliography`` at depth 0
        → insert just before that boundary (no blank line was found
        before it)
      * ``\\end{document}`` → insert just before it
      * end-of-text → insert at end-of-text
    """
    cursor = ref_pos
    depth = 0
    while True:
        progressed = False
        for m in _TOKEN_RE.finditer(text, cursor):
            begin_env = m.group(1)
            end_env = m.group(2)
            sect = m.group(3)
            blank = m.group(4)
            if begin_env is not None:
                if begin_env == "document":
                    continue
                depth += 1
            elif end_env is not None:
                if end_env == "document":
                    return m.start()
                if depth > 0:
                    depth -= 1
                else:
                    cursor = m.end()
                    depth = 0
                    progressed = True
                    break
            elif sect is not None and depth == 0:
                return m.start()
            elif blank is not None and depth == 0:
                return m.start()
        if not progressed:
            return len(text)


def _build_asset_records(outline: dict, ws: Workspace) -> list[dict]:
    """Walk the outline and return one record per asset whose ``.tex``
    file exists on disk.

    Each record carries:

      * ``asset_id`` and ``kind`` (``"table"`` | ``"figure"``)
      * ``label`` — ``\\label{}`` declared inside the asset .tex (may
        be ``None`` if absent or unreadable)
      * ``input_line`` —
        ``"\\input{05_generation/<kind>s/<id>.tex}"``
      * ``owner_label`` — section label used by the no-ref-found
        fallback. Subsection-owned assets bind to that subsection;
        section-owned assets bind to the *last* subsection so they fall
        after the section's textual body, matching the historical
        layout.
    """
    records: list[dict] = []

    def add(asset: dict, kind: str, dir_path: Path, owner_label: str) -> None:
        aid = asset.get("table_id" if kind == "table" else "figure_id") or asset.get("id")
        if not aid:
            return
        tex = dir_path / f"{aid}.tex"
        if not tex.exists():
            return
        sub_dir = "tables" if kind == "table" else "figures"
        records.append({
            "asset_id": aid,
            "kind": kind,
            "label": _asset_label(tex),
            "input_line": f"\\input{{05_generation/{sub_dir}/{aid}.tex}}",
            "owner_label": owner_label,
        })

    for sec in outline.get("outline_tree", []):
        sid = sec.get("section_id") or ""
        subs = sec.get("subsections") or []

        for sub in subs:
            sub_sid = sub.get("section_id") or ""
            if not sub_sid:
                continue
            sub_label = section_label(sub_sid)
            for t in sub.get("tables") or []:
                add(t, "table", ws.tables_dir, sub_label)
            for f in sub.get("figures") or []:
                add(f, "figure", ws.figures_dir, sub_label)

        anchor_sid = subs[-1].get("section_id") if subs else sid
        if not anchor_sid:
            continue
        anchor_label = section_label(anchor_sid)
        for t in sec.get("tables") or []:
            add(t, "table", ws.tables_dir, anchor_label)
        for f in sec.get("figures") or []:
            add(f, "figure", ws.figures_dir, anchor_label)

    return records


def _inject(text: str, records: list[dict]) -> dict:
    """Splice each asset's ``\\input{}`` into ``text`` at the chosen
    anchor. Reference-anchored placement is preferred; sections without
    a prose ref fall back to the pre-existing end-of-section anchor.

    Returns a dict with keys: ``text``, ``input_to_owner``,
    ``missing_owner_labels``, ``refs_resolved``, ``refs_missing``,
    ``already_present``, ``same_paragraph_groups``, ``n_tables``,
    ``n_figures``.
    """
    label_positions: dict[str, int] = {}
    for m in _LABEL_RE.finditer(text):
        if m.group(1) not in label_positions:
            label_positions[m.group(1)] = m.end()

    # Every `\label{}` the draft already declares, of any kind — not just the
    # `sec:` ones `label_positions` indexes. This is the duplicate-float guard:
    # if the prose already carries a float declaring `tab:T1`, injecting the
    # standalone `tables/T1.tex` on top of it produces two floats sharing one
    # label, `\ref{tab:T1}` silently resolving to whichever LaTeX defined last,
    # and a caption numbered twice. A run shipped exactly that. Section writers
    # are now forbidden from writing a table body into their prose and
    # `validate_drafts` rejects one, so this should never fire — it is here
    # because the failure is invisible until a human opens the PDF, and the
    # check costs one regex.
    declared_labels = {m.group(1) for m in _LABEL_IN_ASSET_RE.finditer(text)}

    plans: list[dict] = []
    refs_resolved: list[dict] = []
    refs_missing: list[dict] = []
    missing_owner_labels: list[str] = []
    already_present: list[dict] = []

    for rec in records:
        if rec["label"] and rec["label"] in declared_labels:
            already_present.append({
                "asset_id": rec["asset_id"],
                "label": rec["label"],
                "reason": "the draft already declares this label; not injecting a second float",
            })
            continue

        ref_pos: int | None = None
        if rec["label"]:
            ref_pos = _first_ref_pos(text, rec["label"])

        if ref_pos is not None:
            insert_pos = _insertion_point_for(text, ref_pos)
            scope = "ref"
            order_key = ref_pos
            refs_resolved.append({
                "asset_id": rec["asset_id"],
                "label": rec["label"],
            })
        else:
            owner = rec["owner_label"]
            start = label_positions.get(owner)
            if start is None:
                if owner not in missing_owner_labels:
                    missing_owner_labels.append(owner)
                refs_missing.append({
                    "asset_id": rec["asset_id"],
                    "label": rec["label"],
                    "fallback": "dropped",
                })
                continue
            boundary = _BOUNDARY_RE.search(text, start)
            insert_pos = boundary.start() if boundary else len(text)
            scope = "section_fallback"
            order_key = start
            refs_missing.append({
                "asset_id": rec["asset_id"],
                "label": rec["label"],
                "fallback": "section_anchor",
            })

        plans.append({
            "insert_pos": insert_pos,
            "order_key": order_key,
            "input_line": rec["input_line"],
            "owner_label": rec["owner_label"],
            "asset_id": rec["asset_id"],
            "kind": rec["kind"],
            "scope": scope,
        })

    # Group inserts that resolve to the same paragraph break so multiple
    # assets referenced inside one paragraph stack in the order their
    # refs appear in the prose.
    by_pos: dict[int, list[dict]] = {}
    for p in plans:
        by_pos.setdefault(p["insert_pos"], []).append(p)

    same_paragraph_groups: list[dict] = []
    blocks: list[tuple[int, str, list[dict]]] = []
    for pos, group in by_pos.items():
        group.sort(key=lambda x: x["order_key"])
        if len(group) > 1 and any(g["scope"] == "ref" for g in group):
            same_paragraph_groups.append({
                "asset_ids": [g["asset_id"] for g in group],
                "insert_pos": pos,
            })
        # A blank line between stacked inputs keeps the post-injection
        # adjacency sweep from flagging this as a problem to relocate.
        joined = "\n\n".join(g["input_line"] for g in group)
        block = "\n\n" + joined + "\n"
        blocks.append((pos, block, group))

    blocks.sort(key=lambda x: x[0], reverse=True)
    input_to_owner: dict[str, str] = {}
    for pos, block, group in blocks:
        text = text[:pos] + block + text[pos:]
        for g in group:
            input_to_owner[g["input_line"].strip()] = g["owner_label"]

    n_tables = sum(1 for p in plans if p["kind"] == "table")
    n_figures = sum(1 for p in plans if p["kind"] == "figure")

    return {
        "text": text,
        "input_to_owner": input_to_owner,
        "missing_owner_labels": missing_owner_labels,
        "refs_resolved": refs_resolved,
        "refs_missing": refs_missing,
        "already_present": already_present,
        "same_paragraph_groups": same_paragraph_groups,
        "n_tables": n_tables,
        "n_figures": n_figures,
    }


def _build_outline_index(
    outline: dict,
) -> tuple[list[str], dict[str, str | None], dict[str, list[str]]]:
    """Walk the outline once and return (section_order, parent_of, children_of)
    keyed by ``sec:s<id>`` labels (same convention as
    :func:`section_label`).

    ``section_order`` is the linearised list of labels in document order
    (top-level section, then its subsections, then next top-level, …).
    ``parent_of[label]`` is the parent label or ``None`` for top-level
    sections. ``children_of[label]`` is the ordered list of child
    subsection labels.
    """
    section_order: list[str] = []
    parent_of: dict[str, str | None] = {}
    children_of: dict[str, list[str]] = {}

    for sec in outline.get("outline_tree", []):
        sid = sec.get("section_id") or ""
        if not sid:
            continue
        sec_lbl = section_label(sid)
        section_order.append(sec_lbl)
        parent_of[sec_lbl] = None
        children_of.setdefault(sec_lbl, [])

        for sub in sec.get("subsections") or []:
            sub_sid = sub.get("section_id") or ""
            if not sub_sid:
                continue
            sub_lbl = section_label(sub_sid)
            section_order.append(sub_lbl)
            parent_of[sub_lbl] = sec_lbl
            children_of[sec_lbl].append(sub_lbl)
            children_of.setdefault(sub_lbl, [])

    return section_order, parent_of, children_of


def _label_line_index(lines: list[str]) -> dict[str, int]:
    """Return label -> line index for every ``\\label{sec:s...}`` in lines."""
    out: dict[str, int] = {}
    for i, ln in enumerate(lines):
        m = _LABEL_LINE_RE.search(ln)
        if m and m.group(1) not in out:
            out[m.group(1)] = i
    return out


def _section_body_windows(
    lines: list[str], label_to_line: dict[str, int]
) -> dict[str, tuple[int, int]]:
    """For each label, return (start_line, end_line) where ``start_line`` is
    the line just after the ``\\label{}`` line and ``end_line`` is the line
    holding the next sectioning command (``\\section`` / ``\\subsection`` /
    ``\\bibliography`` / ``\\end{document}``) — exclusive upper bound.
    """
    sect_line_idxs = [
        i for i, ln in enumerate(lines) if _SECTIONING_LINE_RE.search(ln)
    ]
    sect_line_idxs.append(len(lines))  # sentinel
    windows: dict[str, tuple[int, int]] = {}
    for label, lbl_line in label_to_line.items():
        end = next((s for s in sect_line_idxs if s > lbl_line), len(lines))
        windows[label] = (lbl_line + 1, end)
    return windows


def _is_prose_line(line: str) -> bool:
    """Lines that count as 'prose' when validating insertion candidates —
    non-blank lines that are NOT existing ``\\input{}`` directives."""
    return bool(line.strip()) and not _INPUT_LINE_RE.match(line)


def _insertion_candidates(
    lines: list[str],
    start: int,
    end: int,
    excluded_lines: set[int],
) -> list[int]:
    """Blank-line indices in ``[start, end)`` safe to insert a paragraph at.

    A candidate is a blank line that:
      1. is not adjacent to any line in ``excluded_lines`` (already an
         ``\\input{}`` or an asset we have just planned to move there);
      2. has at least one prose line strictly before it within the window;
      3. has at least one prose line strictly after it within the window.

    Constraints 2 and 3 are what prevent the displaced ``\\input{}`` from
    landing immediately after a section ``\\label{}`` (no prose before) or
    immediately before a sectioning command (no prose after) — i.e. the
    very failure mode this whole pass is designed to avoid.
    """
    out: list[int] = []
    for i in range(start, end):
        if lines[i].strip():
            continue
        if (i - 1) in excluded_lines or (i + 1) in excluded_lines:
            continue
        has_prose_before = any(_is_prose_line(lines[j]) for j in range(start, i))
        has_prose_after = any(_is_prose_line(lines[j]) for j in range(i + 1, end))
        if has_prose_before and has_prose_after:
            out.append(i)
    return out


def _top_of_section_candidate(
    label: str | None,
    lines: list[str],
    windows: dict[str, tuple[int, int]],
    excluded_lines: set[int],
    upper_limit: int | None = None,
) -> int | None:
    """The blank line directly under ``\\label{<label>}`` — eligible only
    when the section body is structurally ``[label, blank, prose, ...]``.

    Used as a fallback inside :func:`_widening_search` when the strict
    candidate set (prose on both sides) is empty for the label, e.g. a
    section whose entire body is a single monolithic paragraph with no
    internal paragraph break. Materialising at this slot, with the
    existing rebuild loop's trailing-blank padding, produces the layout
    ``[label, blank, \\input{}, blank, prose]`` — i.e. the displaced
    asset lands inside its owning section instead of falling through to
    ``last_resort`` near the bibliography.

    Eligibility:
      * the label exists in ``windows``;
      * ``lines[lbl + 1]`` is blank (one blank between label and the
        first prose line);
      * ``lines[lbl + 2]`` is real prose — non-blank, not an existing
        ``\\input{}`` directive, not a sectioning command;
      * the candidate blank is not adjacent to any line in
        ``excluded_lines`` (existing or planned ``\\input{}`` neighbour).

    ``upper_limit`` mirrors :func:`_try_label_window` — used by the
    parent-intro tier to keep the candidate from sliding past the first
    subsection's label.
    """
    if not label or label not in windows:
        return None
    body_start, body_end = windows[label]
    if upper_limit is not None:
        body_end = min(body_end, upper_limit)
    if body_start >= body_end:
        return None
    if body_start >= len(lines) or lines[body_start].strip():
        return None
    next_idx = body_start + 1
    if next_idx >= body_end or next_idx >= len(lines):
        return None
    next_line = lines[next_idx]
    if not next_line.strip():
        return None
    if _INPUT_LINE_RE.match(next_line):
        return None
    if _SECTIONING_LINE_RE.search(next_line):
        return None
    if (body_start - 1) in excluded_lines or (body_start + 1) in excluded_lines:
        return None
    return body_start


def _find_adjacency_runs(lines: list[str]) -> list[list[int]]:
    """Return runs of consecutive line indices (length ≥ 2) where every line
    is an ``\\input{}`` directive and they sit on adjacent line indices with
    no blank between them."""
    runs: list[list[int]] = []
    cur: list[int] = []
    for i, ln in enumerate(lines):
        if _INPUT_LINE_RE.match(ln):
            if cur and cur[-1] == i - 1:
                cur.append(i)
            else:
                if len(cur) >= 2:
                    runs.append(cur)
                cur = [i]
        else:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
    if len(cur) >= 2:
        runs.append(cur)
    return runs


def _pick_best_candidate(
    candidates: list[int], occupied: set[int]
) -> int | None:
    """Choose the candidate furthest (by minimum distance) from any
    occupied ``\\input{}`` line. Ties break toward earlier candidates."""
    if not candidates:
        return None
    if not occupied:
        return candidates[0]
    def score(c: int) -> int:
        return min(abs(c - o) for o in occupied)
    return max(candidates, key=lambda c: (score(c), -c))


def _try_label_window(
    label: str | None,
    lines: list[str],
    windows: dict[str, tuple[int, int]],
    occupied: set[int],
    upper_limit: int | None = None,
) -> int | None:
    """Pick a candidate inside ``windows[label]`` (optionally capped at
    ``upper_limit``). Returns ``None`` if no candidate."""
    if not label or label not in windows:
        return None
    s, e = windows[label]
    if upper_limit is not None:
        e = min(e, upper_limit)
    if e <= s:
        return None
    return _pick_best_candidate(
        _insertion_candidates(lines, s, e, occupied), occupied
    )


def _widening_search(
    owning_label: str | None,
    lines: list[str],
    occupied: set[int],
    windows: dict[str, tuple[int, int]],
    section_order: list[str],
    parent_of: dict[str, str | None],
    children_of: dict[str, list[str]],
) -> tuple[int | None, str]:
    """Locate a target paragraph break for one displaced ``\\input{}``.

    Returns ``(line_idx, scope_level)`` where ``scope_level`` is one of
    ``own | own_top | sibling_sub | sibling_sub_top | parent_intro |
    parent_intro_top | adjacent_section | adjacent_section_top |
    last_resort``. Each label-scoped tier first tries the strict
    paragraph-break candidates inside that label's body window
    (``..._top``-suffixed scopes are the relaxed top-of-section fallback
    used when the section body is a single monolithic paragraph). The
    first hit wins.
    """
    # Tier 1 — owning section/subsection body.
    pick = _try_label_window(owning_label, lines, windows, occupied)
    if pick is not None:
        return pick, "own"
    pick = _top_of_section_candidate(owning_label, lines, windows, occupied)
    if pick is not None:
        return pick, "own_top"

    parent = parent_of.get(owning_label) if owning_label else None

    # Tier 2 — sibling subsections of the same parent (alternating
    # forward/backward from the owner's position in the parent's child
    # list).
    if parent:
        siblings = children_of.get(parent, [])
        try:
            own_pos = siblings.index(owning_label)  # type: ignore[arg-type]
        except ValueError:
            own_pos = -1
        ordered_siblings: list[str] = []
        for delta in range(1, max(len(siblings), 1)):
            for d in (delta, -delta):
                idx = own_pos + d
                if 0 <= idx < len(siblings) and siblings[idx] != owning_label:
                    if siblings[idx] not in ordered_siblings:
                        ordered_siblings.append(siblings[idx])
        for sib in ordered_siblings:
            pick = _try_label_window(sib, lines, windows, occupied)
            if pick is not None:
                return pick, "sibling_sub"
            pick = _top_of_section_candidate(sib, lines, windows, occupied)
            if pick is not None:
                return pick, "sibling_sub_top"

    # Tier 3 — parent section's own intro body (between the parent's
    # ``\\label{}`` and the first subsection's ``\\label{}``).
    if parent and parent in windows:
        first_sub_label = (children_of.get(parent) or [None])[0]
        upper = None
        if first_sub_label and first_sub_label in windows:
            upper = max(windows[parent][0], windows[first_sub_label][0] - 1)
        pick = _try_label_window(
            parent, lines, windows, occupied, upper_limit=upper
        )
        if pick is not None:
            return pick, "parent_intro"
        pick = _top_of_section_candidate(
            parent, lines, windows, occupied, upper_limit=upper
        )
        if pick is not None:
            return pick, "parent_intro_top"

    # Tier 4 — adjacent top-level sections (alternating forward/backward
    # from the owner's anchor section). Within each adjacent section, try
    # its own intro body, then each of its subsections in declaration
    # order.
    anchor: str | None = owning_label
    while anchor and parent_of.get(anchor):
        anchor = parent_of[anchor]
    top_sections = [s for s in section_order if parent_of.get(s) is None]
    if anchor in top_sections:
        own_idx = top_sections.index(anchor)  # type: ignore[arg-type]
        ordered_sections: list[str] = []
        for delta in range(1, max(len(top_sections), 1)):
            for d in (delta, -delta):
                idx = own_idx + d
                if 0 <= idx < len(top_sections):
                    cand = top_sections[idx]
                    if cand not in ordered_sections:
                        ordered_sections.append(cand)
        for sec in ordered_sections:
            for cand_label in [sec, *children_of.get(sec, [])]:
                pick = _try_label_window(cand_label, lines, windows, occupied)
                if pick is not None:
                    return pick, "adjacent_section"
                pick = _top_of_section_candidate(
                    cand_label, lines, windows, occupied
                )
                if pick is not None:
                    return pick, "adjacent_section_top"

    # Tier 5 — last resort. Scan the entire document for any blank line
    # with prose on both sides and no excluded neighbour.
    pick = _pick_best_candidate(
        _insertion_candidates(lines, 0, len(lines), occupied), occupied
    )
    if pick is not None:
        return pick, "last_resort"
    return None, "none"


def _extract_asset_id(input_line: str) -> str:
    m = _ASSET_ID_RE.search(input_line)
    return m.group(1) if m else input_line.strip()


def _rearrange_adjacent(
    text: str,
    outline: dict,
    input_to_owner: dict[str, str],
) -> tuple[str, dict]:
    """Detect adjacent ``\\input{}`` lines emitted by :func:`_inject` and
    move all-but-the-first to a paragraph break chosen by widening search.

    Always finds a target (tiers 1 → 5); the only way ``_rearrange_adjacent``
    leaves an adjacency in place is if the entire document is structurally
    empty (no prose paragraph breaks anywhere). Returns
    ``(new_text, info)`` where ``info`` carries diagnostics for the status
    JSON.
    """
    lines = text.split("\n")
    runs = _find_adjacency_runs(lines)
    if not runs:
        return text, {
            "adjacencies_detected": 0,
            "relocations": [],
            "unresolved": [],
        }

    section_order, parent_of, children_of = _build_outline_index(outline)
    label_to_line = _label_line_index(lines)
    windows = _section_body_windows(lines, label_to_line)

    occupied: set[int] = {
        i for i, ln in enumerate(lines) if _INPUT_LINE_RE.match(ln)
    }
    displaced_idxs: set[int] = set()
    planned_targets: set[int] = set()
    relocations: list[dict] = []
    unresolved: list[dict] = []
    moves: list[dict] = []

    for run in runs:
        # Keep the first input in the run at its current position; displace
        # every other input.
        for displaced_idx in run[1:]:
            line_text = lines[displaced_idx]
            owner = input_to_owner.get(line_text.strip())
            # Occupancy seen by widening search:
            #   - all existing input lines
            #   - minus the displaced lines we have already pulled out
            #   - plus the targets we have already planned in this pass
            current_occupied = (occupied - displaced_idxs) | planned_targets
            target, scope = _widening_search(
                owner, lines, current_occupied,
                windows, section_order, parent_of, children_of,
            )
            asset_id = _extract_asset_id(line_text)
            if target is None:
                unresolved.append({"input": asset_id, "owner": owner})
                continue
            displaced_idxs.add(displaced_idx)
            planned_targets.add(target)
            moves.append({
                "source_line": displaced_idx,
                "target_line": target,
                "line_text": line_text,
            })
            relocations.append({
                "input": asset_id,
                "from_owner": owner,
                "scope_level": scope,
                "target_line": target,
            })

    if not moves:
        return text, {
            "adjacencies_detected": len(runs),
            "relocations": [],
            "unresolved": unresolved,
        }

    inserts_by_target: dict[int, list[str]] = {}
    for m in moves:
        inserts_by_target.setdefault(m["target_line"], []).append(m["line_text"])

    new_lines: list[str] = []
    for i, ln in enumerate(lines):
        if i in displaced_idxs:
            continue
        new_lines.append(ln)
        if i in inserts_by_target:
            for input_line in inserts_by_target[i]:
                new_lines.append(input_line)
                new_lines.append("")  # blank-line padding after each insert

    return "\n".join(new_lines), {
        "adjacencies_detected": len(runs),
        "relocations": relocations,
        "unresolved": unresolved,
    }


# ---------------------------------------------------------------------------
# Shared with the Markdown branch: asset .tex hygiene and citations.bib
# ---------------------------------------------------------------------------

_MD_SPACED_CITE_RE = re.compile(r"\\[ \t]+(cite[tp]?)\b")


def _normalize_commands(text: str, markdown: bool) -> tuple[str, dict[str, int]]:
    """Repair `\\ citet{}` in either dialect; repair escaped math in LaTeX only.

    A spaced citation command is invisible to every cite-key scan in the
    pipeline, so it has to be fixed on both paths. `\\$\\beta\\$` -> `$\\beta$`
    does not: Markdown has no math mode to rescue the macro into, and the
    rewrite would invent inline maths the drafter did not write. Same return
    shape either way, so the status row does not branch.
    """
    if not markdown:
        return normalize_latex_commands(text)
    text, count = _MD_SPACED_CITE_RE.subn(r"\\\1", text)
    return text, {"spaced_cite": count, "escaped_math_macro": 0}


def _normalize_asset_tex(ws: Workspace) -> tuple[dict, dict[str, str]]:
    """Repair `\\ citet{}` / `\\$\\beta\\$` inside every asset .tex, in place.

    Runs on both paths. A malformed citation command in a caption is invisible
    to the bib scan in either dialect — the asset content never flows through
    the merged document — so this is the choke point where it gets fixed.
    Returns `(fix_counts, {filename: normalized_content})`.
    """
    fixes = {"spaced_cite": 0, "escaped_math_macro": 0}
    content_by_name: dict[str, str] = {}
    for asset_dir in (ws.tables_dir, ws.figures_dir):
        if not asset_dir.exists():
            continue
        for tex_file in sorted(asset_dir.glob("*.tex")):
            raw_text = tex_file.read_text(encoding="utf-8")
            tex_content, delta = normalize_latex_commands(raw_text)
            if tex_content != raw_text:
                if (ws.gen/'_internal/manuscript_contract.json').exists():
                    raise ValueError('sealed asset needs normalization before accept/seal: '+str(tex_file))
                tex_file.write_text(tex_content, encoding="utf-8")
                fixes["spaced_cite"] += delta["spaced_cite"]
                fixes["escaped_math_macro"] += delta["escaped_math_macro"]
            content_by_name[tex_file.name] = tex_content
    return fixes, content_by_name


def _emit_citations_bib(ws: Workspace, document_text: str,
                        asset_content_by_name: dict[str, str]) -> dict:
    """Write `05_generation/citations.bib` — the cited-only scope of the corpus.

    `03_process/references.bib` was rendered by
    `scripts/processing/build_bib.py` at the processing stage, from the same
    `render_bibtex_entry` and the same cite keys. When it is present this step
    is a *selection*: pull out the entries that were actually cited, in
    first-citation order. Re-rendering here would produce byte-identical text
    today, but it would let the two copies drift the moment either side's
    metadata handling changes, and the cheapest way to guarantee the document's
    bibliography matches the corpus bibliography is to only ever have rendered
    it once.

    Fallback matters: a workspace that reached this phase before build_bib.py
    existed has no references.bib, and must still publish. Per-key too, not just
    per-file — a cite key absent from references.bib (an edited corpus, a
    hand-added key) is rendered from selected_paper.json exactly as before.

    Order follows the document, expanding an `\\input{}` where it appears rather
    than after all prose, so citations.bib's entry order matches the order
    BibTeX sees. On the Markdown path there are no `\\input{}` lines — the asset
    content is already inline — so the walk simply finds the cites in place.
    """
    cite_keys_map = load_json(ws.cite_keys_path())
    pid_by_key = {ck: pid for pid, ck in cite_keys_map.items()}
    selected_papers = load_json(ws.selected_papers_path)
    paper_cards = load_json(ws.paper_cards_path) if ws.paper_cards_path.exists() else {}

    all_used_keys: dict[str, None] = {}  # ordered set, first-citation order

    def add_cites_from(text: str) -> None:
        for raw in re.findall(r"\\cite[tp]?\{([^}]+)\}", text):
            for key in raw.split(","):
                key = key.strip()
                if key:
                    all_used_keys.setdefault(key, None)

    seen_assets: set[str] = set()
    for match in re.finditer(r"\\cite[tp]?\{([^}]+)\}|\\input\{([^}]+)\}", document_text):
        if match.group(1) is not None:
            for key in match.group(1).split(","):
                key = key.strip()
                if key:
                    all_used_keys.setdefault(key, None)
            continue
        name = match.group(2).strip().split("/")[-1]
        if not name.endswith(".tex"):
            name += ".tex"
        if name in asset_content_by_name:
            seen_assets.add(name)
            add_cites_from(asset_content_by_name[name])

    # Safety net: any asset not reached via an \input (path mismatch, or the
    # Markdown path, where there are none) still contributes, appended last.
    for name, content in asset_content_by_name.items():
        if name not in seen_assets:
            add_cites_from(content)

    reference_entries: dict[str, str] = {}
    references_bib = ws.process / "references.bib"
    if references_bib.exists():
        try:
            reference_entries = parse_bibtex_entries(
                references_bib.read_text(encoding="utf-8"))
        except OSError:
            reference_entries = {}
    bib_source = "03_process/references.bib" if reference_entries else "rendered_here"

    used_keys_list = list(all_used_keys)
    bib_lines = ["% Auto-generated BibTeX by phase05b_insert_assets.py"]
    missing_cite_keys: list[str] = []
    bibtex_upstream = bibtex_synthesised = bibtex_selected = 0
    for ck in used_keys_list:
        pid = pid_by_key.get(ck)
        paper_meta = selected_papers.get(pid, {}) if pid else {}
        entry = reference_entries.get(ck)
        if not paper_meta and not entry:
            missing_cite_keys.append(ck)
            bib_lines.append(f"% MISSING: no metadata for cite_key {ck}")
            continue
        # Provenance counters describe where the *metadata* came from, not which
        # of the two paths rendered it, so they stay comparable across runs.
        cs = paper_meta.get("citationStyles")
        if isinstance(cs, dict) and (cs.get("bibtex") or "").strip():
            bibtex_upstream += 1
        else:
            bibtex_synthesised += 1
        if entry:
            bibtex_selected += 1
        else:
            card = paper_cards.get(pid, {}) if pid else {}
            entry = render_bibtex_entry(ck, paper_meta, card=card)
        bib_lines.append("")
        bib_lines.append(entry)
    ws.citations_bib_path.write_text("\n".join(bib_lines) + "\n", encoding="utf-8")

    return {
        "cite_keys_used": len(used_keys_list),
        "cite_keys_missing": missing_cite_keys,
        "bibtex_upstream": bibtex_upstream,
        "bibtex_synthesised": bibtex_synthesised,
        "bib_source": bib_source,
        "bibtex_selected": bibtex_selected,
    }


# ---------------------------------------------------------------------------
# Markdown asset placement
# ---------------------------------------------------------------------------

# A reference plus the carrier word that introduces it, so "Figure~\ref{fig:F1}"
# becomes one link rather than the word "Figure" followed by a link that also
# says "Figure 1".
_MD_ASSET_REF_RE = re.compile(
    r"(?:(?:Figures?|Figs?\.?|Tables?|Tabs?\.?|图|表)\s*~?\s*)?"
    rf"\\{_REF_CMDS}\{{(fig|tab):([\w\-]+)\}}"
)
_MD_ASSET_REF_BARE_RE = re.compile(rf"\\{_REF_CMDS}\{{(fig|tab):([\w\-]+)\}}")
_MD_SECTION_REF_RE = re.compile(rf"\\{_REF_CMDS}\{{sec:s([\w\-]+)\}}")


def _markdown_place_assets(ws: Workspace, text: str, outline: dict,
                           language: str) -> tuple[str, dict]:
    """Render every asset into `text` and turn its `\\ref{}` into a link.

    Numbering follows first mention, which is the only order a reader can
    verify against the prose. Assets nobody mentioned keep their content but
    move to an appendix, and are reported so the shortfall is visible in the
    status row rather than only in the file.
    """
    words = labels_for(language)
    worklist_items: list[dict] = []
    if ws.figures_worklist_path().exists():
        try:
            worklist_items = (load_json(ws.figures_worklist_path()) or {}).get("items", [])
        except Exception:  # noqa: BLE001
            worklist_items = []

    figures = scan_figures(ws.figures_dir, worklist_items)
    tables = scan_tables(ws.tables_dir)

    # Only assets the outline declared, so a stale .tex from an earlier run with
    # a different outline cannot reappear in the document.
    declared: list[tuple[str, str]] = []   # (kind, short_label)
    for rec in _build_asset_records(outline, ws):
        label = rec["label"] or ""
        if ":" not in label:
            continue
        prefix, short = label.split(":", 1)
        if prefix == "fig" and short in figures:
            declared.append(("figure", short))
        elif prefix == "tab" and short in tables:
            declared.append(("table", short))

    declared_figs = [s for k, s in declared if k == "figure"]
    declared_tabs = [s for k, s in declared if k == "table"]

    # -- numbering, by first mention ----------------------------------------
    fig_numbers: dict[str, int] = {}
    tab_numbers: dict[str, int] = {}
    for match in _MD_ASSET_REF_BARE_RE.finditer(text):
        kind, short = match.group(1), match.group(2)
        if kind == "fig" and short in declared_figs and short not in fig_numbers:
            fig_numbers[short] = len(fig_numbers) + 1
        elif kind == "tab" and short in declared_tabs and short not in tab_numbers:
            tab_numbers[short] = len(tab_numbers) + 1

    orphan_figs = [s for s in declared_figs if s not in fig_numbers]
    orphan_tabs = [s for s in declared_tabs if s not in tab_numbers]
    for short in orphan_figs:
        fig_numbers[short] = len(fig_numbers) + 1
    for short in orphan_tabs:
        tab_numbers[short] = len(tab_numbers) + 1

    # -- placement ----------------------------------------------------------
    plans: list[dict] = []
    refs_resolved: list[dict] = []
    for kind, short in declared:
        if kind == "figure":
            if short in orphan_figs:
                continue
            block = render_figure_md(figures[short], fig_numbers[short], language)
        else:
            if short in orphan_tabs:
                continue
            block = render_table_md(tables[short], tab_numbers[short], language)
        ref_pos = _first_ref_pos(text, f"{'fig' if kind == 'figure' else 'tab'}:{short}")
        if ref_pos is None:      # cannot happen — numbered means referenced
            continue
        plans.append({
            "insert_pos": _insertion_point_for(text, ref_pos),
            "order_key": ref_pos,
            "block": block,
            "kind": kind,
            "asset_id": short,
        })
        refs_resolved.append({"asset_id": short,
                              "label": f"{'fig' if kind == 'figure' else 'tab'}:{short}"})

    by_pos: dict[int, list[dict]] = {}
    for plan in plans:
        by_pos.setdefault(plan["insert_pos"], []).append(plan)

    same_paragraph_groups = [
        {"asset_ids": [p["asset_id"] for p in sorted(group, key=lambda x: x["order_key"])],
         "insert_pos": pos}
        for pos, group in by_pos.items() if len(group) > 1
    ]

    for pos in sorted(by_pos, reverse=True):
        group = sorted(by_pos[pos], key=lambda x: x["order_key"])
        joined = "\n\n".join(p["block"] for p in group)
        text = text[:pos] + "\n\n" + joined + "\n" + text[pos:]

    # -- references become links -------------------------------------------
    def link(match: re.Match) -> str:
        kind, short = match.group(1), match.group(2)
        if kind == "fig" and short in fig_numbers:
            return f'[{words["figure"]} {fig_numbers[short]}](#fig-{short})'
        if kind == "tab" and short in tab_numbers:
            return f'[{words["table"]} {tab_numbers[short]}](#tab-{short})'
        return ""      # points at an asset that never materialised

    text = _MD_ASSET_REF_RE.sub(link, text)
    text = _MD_SECTION_REF_RE.sub(lambda m: "§" + m.group(1).replace("_", "."), text)

    # -- the appendix -------------------------------------------------------
    if orphan_figs or orphan_tabs:
        text = text.rstrip() + f"\n\n## {words['appendix']}\n\n"
        for short in orphan_figs:
            text += render_figure_md(figures[short], fig_numbers[short], language) + "\n\n"
        for short in orphan_tabs:
            text += render_table_md(tables[short], tab_numbers[short], language) + "\n\n"

    return text.rstrip() + "\n", {
        "n_tables": len(tab_numbers),
        "n_figures": len(fig_numbers),
        "refs_resolved": refs_resolved,
        "refs_missing": (
            [{"asset_id": s, "label": f"fig:{s}", "fallback": "appendix"} for s in orphan_figs]
            + [{"asset_id": s, "label": f"tab:{s}", "fallback": "appendix"} for s in orphan_tabs]
        ),
        "same_paragraph_groups": same_paragraph_groups,
        "tables_degraded_to_html": sorted(
            s for s in tab_numbers if tables[s].get("render_mode") != "gfm"),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--scope", default="speed", choices=["speed", "deep"])
    p.add_argument("--language", default=None, choices=["english", "chinese"])
    p.add_argument(
        "--no-llm-scrub", action="store_true",
        help="skip the LLM paragraph-rewrite tier of the dropped-figure \\ref "
             "scrub; use the regex pre-scrub and sentence-delete tiers only. "
             "Makes this script API-call-free, which is what the agentic "
             "generation_publish stage wants.",
    )
    args = p.parse_args()

    started = time.time()
    ws = Workspace()
    ws.ensure_output_dirs()
    log_script_start(ws, "phase05b_insert_assets", scope=args.scope)

    # Resolve language for status traceability only — this script does not
    # care about language since it only edits LaTeX structurally.
    if args.language:
        language = args.language
    elif ws.query_meta_path().exists():
        language = (load_json(ws.query_meta_path()) or {}).get("language", "english")
    else:
        language = "english"

    spec = read_output_spec(ws.root)
    markdown = spec["format"] == "markdown"

    # Pick the source: prefer v2 (refined), fall back to v1. The dialect
    # decides only the file extension — the refiner subagent writes v2 in
    # whichever dialect it was given.
    if markdown:
        v2_path, v1_path = ws.gen / FULL_DRAFT_V2_MD, ws.gen / FULL_DRAFT_V1_MD
        v3_path = ws.gen / FULL_DRAFT_V3_MD
    else:
        v2_path, v1_path = ws.full_draft_v2_path, ws.full_draft_v1_path
        v3_path = ws.full_draft_v3_path

    whole_manuscript = (ws.gen / "_internal/manuscript_contract.json").exists()
    if whole_manuscript:
        sys.path.insert(0, str(_slr_paths.HOME / "scripts"))
        from manuscript import verify_accepted
        verify_accepted(ws.root)
    receipt = ws.gen / "_status/writing_review.json"
    if not whole_manuscript and receipt.exists() and v2_path.exists():
        from writing_contract import digest
        reviewed = load_json(receipt)
        if (not v1_path.exists() or reviewed.get("base_sha256") != digest(v1_path.read_text())
                or reviewed.get("result_sha256") != digest(v2_path.read_text())):
            raise ValueError("reviewed draft changed; prepare and apply a fresh writing review before publication")

    if whole_manuscript:
        source, source_kind = v1_path, "whole_manuscript"
    elif v2_path.exists():
        source, source_kind = v2_path, "v2"
    elif v1_path.exists():
        source, source_kind = v1_path, "v1_fallback"
    else:
        write_status(
            ws,
            "phase05b_insert_assets",
            "FAILED",
            duration_sec=round(time.time() - started, 2),
            scope=args.scope,
            language=language,
            output_format=spec["format"],
            output_spec_source=spec["spec_source"],
            output_spec_error=spec["spec_error"],
            error=f"Neither {v2_path.name} nor {v1_path.name} exists",
        )
        return 1

    publication_outline=ws.gen/'_internal/publication_outline.json'
    outline = load_json(publication_outline) if publication_outline.exists() else load_outline(ws.root)

    text = source.read_text(encoding="utf-8")
    # Remove prose references to figures that failed to render (dropped, not
    # placeheld) BEFORE placement, so nothing ever anchors on a dead ref.
    dropped_labels = _dropped_figure_labels(ws)
    text, scrub_info = _scrub_dropped_figure_refs(
        ws, text, dropped_labels, use_llm=not args.no_llm_scrub
    )
    # Asset .tex hygiene, on both paths: a `\ citet{}` in a caption is invisible
    # to the cite-key scan below in either dialect.
    asset_fixes, asset_content_by_name = _normalize_asset_tex(ws)

    if markdown:
        new_text, result = _markdown_place_assets(ws, text, outline, language)
        new_text, latex_fixes = _normalize_commands(new_text, markdown=True)
        # Adjacency is an `\input{}` problem: two consecutive one-line
        # directives read as one block to LaTeX. Rendered Markdown blocks are
        # already separated by blank lines and captions, so there is nothing to
        # detect and the keys stay for shape parity.
        rearrange_info = {"adjacencies_detected": 0, "relocations": [], "unresolved": []}
        missing_owner_labels: list[str] = []
    else:
        records = _build_asset_records(outline, ws)
        result = _inject(text, records)
        new_text = result["text"]
        # Repair LLM LaTeX malformations (`\ citet{}`, `\$\beta\$`) BEFORE the
        # cite-key scan and v3 write — this is the single choke point where the
        # fix lands in both the compiled document and citations.bib.
        new_text, latex_fixes = normalize_latex_commands(new_text)
        # Post-injection: split any remaining adjacent `\input{}` runs by
        # moving all but the first to a paragraph break chosen via widening
        # search. With ref-anchored placement this rarely fires, but it
        # remains as a safety net for fallback-anchored stacks.
        new_text, rearrange_info = _rearrange_adjacent(
            new_text, outline, result["input_to_owner"]
        )
        missing_owner_labels = result["missing_owner_labels"]

    v3_path.write_text(new_text, encoding="utf-8")

    bib = _emit_citations_bib(ws, new_text, asset_content_by_name)

    status = (
        "PARTIAL_SUCCESS"
        if (missing_owner_labels or source_kind == "v1_fallback"
            or bib["cite_keys_missing"] or dropped_labels)
        else "SUCCESS"
    )
    write_status(
        ws,
        "phase05b_insert_assets",
        status,
        duration_sec=round(time.time() - started, 2),
        scope=args.scope,
        language=language,
        output_format=spec["format"],
        output_spec_source=spec["spec_source"],
        output_spec_error=spec["spec_error"],
        source=str(source),
        source_kind=source_kind,
        output=str(v3_path),
        full_draft_v3=str(v3_path),
        citations_bib=str(ws.citations_bib_path),
        cite_keys_used=bib["cite_keys_used"],
        cite_keys_missing=bib["cite_keys_missing"],
        bibtex_upstream=bib["bibtex_upstream"],
        bibtex_synthesised=bib["bibtex_synthesised"],
        bib_source=bib["bib_source"],
        bibtex_selected=bib["bibtex_selected"],
        latex_fixes=latex_fixes,
        latex_fixes_assets=asset_fixes,
        tables_inserted=result["n_tables"],
        figures_inserted=result["n_figures"],
        tables_degraded_to_html=result.get("tables_degraded_to_html", []),
        figures_dropped=dropped_labels,
        ref_scrub=scrub_info,
        refs_resolved=result["refs_resolved"],
        refs_missing=result["refs_missing"],
        # Non-empty means a float declaring this label was already in the
        # prose, so the standalone asset was NOT injected on top of it. That is
        # the right outcome, but it is also a defect upstream: a section writer
        # wrote a table body into its draft. Worth reporting, never worth
        # failing over — the document is correct either way.
        assets_already_present=result.get("already_present", []),
        same_paragraph_groups=result["same_paragraph_groups"],
        missing_labels=missing_owner_labels,
        adjacencies_detected=rearrange_info["adjacencies_detected"],
        relocations=rearrange_info["relocations"],
        unresolved_adjacencies=rearrange_info["unresolved"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
