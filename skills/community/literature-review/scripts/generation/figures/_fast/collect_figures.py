"""collect_figures.py — gather figure specs from the workspace outline.

Builds a figure-planning contract entirely from the outline and processed
corpus, before section drafting starts.

Reads:
    {workspace}/04_outline/outline.json
    {workspace}/02_retrieval/selected_paper.json
    {workspace}/03_process/paper_cards.json
    {workspace}/05_generation/_internal/query_meta.json (from phase 0 bootstrap, optional)

Writes:
    {workspace}/05_generation/_internal/figures_worklist.json

Each entry:
    figure_id          str  — outline figure_id
    label              str  — "fig:<figure_id>"
    caption_skeleton   str  — the outline's caption (user intent)
    outline_plan       dict — everything else the architect wrote about this
                              figure, verbatim: what it is for, what to draw,
                              how the parts relate, whatever keys it used. The
                              architect saw the whole corpus and decided this
                              figure should exist; the planner is deciding how
                              to render it, not what it is. Passing only a
                              caption is how one run ended up with a bar chart
                              of publication years under a caption that had
                              promised a taxonomy.
    scope              str  — "speed" | "deep" (mirrors top-level)
    total_paper_pool   int  — unique paper_ids in this figure's section (incl. subsections)
    section_id         str
    section_title      str
    section_description str
    paper_ids          list[str]
    related_papers     list[ paper card pass-through ] — each entry is
                              {cite_key, **format_paper_card(...)}; format_paper_card
                              returns the full card (abstract, common_fields.*,
                              card.method.*, card.experiments.*, card.discussion.*,
                              card.summary.*, card.analysis.*, …) with only
                              pure-bookkeeping fields (paperId, info_type,
                              has_parse_dict, reading_depth) stripped.
    _render_mode       null  — to be filled by the agent
                                ("image" for a diagram, "forest_taxonomy" for a hierarchy
                                 drawn natively in LaTeX, "data_chart" for a statistic
                                 computed from the corpus — which a survey rarely wants)
    _prompt            null  — to be filled by the agent (only for "image" mode)
    _latex_body        null  — to be filled by the agent (only for "forest_taxonomy")
    _chart_spec        null  — to be filled by the agent (only for "data_chart"):
                                {statistic, chart_type, x_label, y_label, ...}. Names a
                                statistic; carries NO numbers — see compute_chart_data.py.
    _caption           null  — to be filled by the agent
    _generated         null  — to be filled by generate_images.py
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
import sys
import time

pass
from writing_contract import load_outline
from _utils import (  # noqa: E402
    Workspace,
    format_paper_card,
    iter_all_sections,
    load_json,
    log_script_start,
    read_query_meta,
    write_json,
    write_status,
)


def main() -> int:
    p = argparse.ArgumentParser()
    p.parse_args()

    started = time.time()
    ws = Workspace()
    log_script_start(ws, "collect_figures")

    outline = load_outline(ws.root)
    selected_papers = load_json(ws.selected_papers_path)
    paper_cards = load_json(ws.paper_cards_path)
    cite_keys = load_json(ws.cite_keys_path()) if ws.cite_keys_path().exists() else {}

    # Resolve query meta (scope / language). Prefer the cached file from
    # phase 0 bootstrap; fall back to a fresh parse for direct re-runs.
    if ws.query_meta_path().exists():
        query_meta = load_json(ws.query_meta_path())
    else:
        query = __import__("task_contract").read_query(ws.input.parent)
        query_meta = read_query_meta(query, outline)
    scope = query_meta.get("scope", "speed")
    language = query_meta.get("language", "english")

    # Pre-compute the paper pool per top-level section (incl. its subsections),
    # so the agent can decide whether a forest taxonomy is worth drawing.
    section_paper_pool: dict[str, int] = {}
    for parent_sec in outline.get("outline_tree", []):
        pool: set[str] = set(parent_sec.get("paper_ids") or [])
        for sub in parent_sec.get("subsections") or []:
            for pid in sub.get("paper_ids") or []:
                pool.add(pid)
        section_paper_pool[parent_sec.get("section_id")] = len(pool)

    # Idempotency: preserve agent-authored fields across reruns.
    existing = {}
    if ws.figures_worklist_path().exists():
        prev = load_json(ws.figures_worklist_path())
        for it in (prev.get("items") or []):
            existing[it["figure_id"]] = {
                "_render_mode": it.get("_render_mode"),
                "_prompt": it.get("_prompt"),
                "_latex_body": it.get("_latex_body"),
                "_caption": it.get("_caption"),
                # `_chart_spec` is agent-authored too: losing it on a re-collect
                # would turn a planned data_chart into a mode with no plan, and
                # the figure would be dropped for a reason nobody could see.
                "_chart_spec": it.get("_chart_spec"),
                # The canvas shape the planner chose for an `image` figure.
                # Same reasoning as `_chart_spec`: losing it silently reverts
                # the figure to `wide`, which is a different figure.
                "_image_size": it.get("_image_size"),
                "_generated": it.get("_generated"),
                # Regenerating an image costs ~40s and real money, so the
                # provenance of one already on disk has to survive a
                # re-collect or `generate_images.py` cannot tell it is cached.
                "_image_meta": it.get("_image_meta"),
            }

    items: list[dict] = []
    for parent, sec in iter_all_sections(outline):
        for f in sec.get("figures") or []:
            fid = f.get("figure_id") or f.get("id")
            if not fid:
                continue
            paper_ids = f.get("paper_ids") or []
            related = []
            for pid in paper_ids:
                ck = cite_keys.get(pid, "")
                related.append({
                    "cite_key": ck,
                    **format_paper_card(paper_cards.get(pid), selected_papers.get(pid, {})),
                })
            top_level_sid = (parent or sec).get("section_id")
            prev = existing.get(fid) or {}
            # Whatever the architect wrote beyond the three keys the outline
            # contract requires. It is not enumerated here on purpose: the
            # architect writes what this figure needs said, and a fixed key
            # list here would silently drop the half of it that did not fit.
            outline_plan = {k: v for k, v in f.items()
                            if k not in ("figure_id", "caption", "paper_ids")
                            and v not in (None, "", [], {})}
            items.append({
                "figure_id": fid,
                "label": f"fig:{fid}",
                "caption_skeleton": f.get("caption_draft", ""),
                "outline_plan": outline_plan,
                "type": f.get("type") or "",
                "scope": scope,
                "language": language,
                "total_paper_pool": section_paper_pool.get(top_level_sid, 0),
                "section_id": sec.get("section_id"),
                "section_title": sec.get("title"),
                "section_description": sec.get("description"),
                "paper_ids": paper_ids,
                "related_papers": related,
                "_render_mode": prev.get("_render_mode"),
                "_prompt": prev.get("_prompt"),
                "_latex_body": prev.get("_latex_body"),
                "_caption": prev.get("_caption"),
                "_chart_spec": prev.get("_chart_spec"),
                "_image_size": prev.get("_image_size"),
                "_generated": prev.get("_generated"),
                "_image_meta": prev.get("_image_meta"),
            })

    write_json(ws.figures_worklist_path(), {"scope": scope, "language": language, "items": items})
    write_status(
        ws, "collect_figures", "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        scope=scope,
        language=language,
        items=len(items),
        existing_pngs=sum(1 for it in items if it["_generated"]),
        forest_items=sum(1 for it in items if it.get("_render_mode") == "forest_taxonomy"),
        worklist_path=str(ws.figures_worklist_path()),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
