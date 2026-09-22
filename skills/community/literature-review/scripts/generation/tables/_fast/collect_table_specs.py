"""collect_table_specs.py — gather table specs from the outline.

For every table in outline_tree (sections[].tables and
sections[].subsections[].tables), pulls the paper cards for the listed
paper_ids so the agent can write a comparison table without further lookups.

Reads:
    {workspace}/04_outline/outline.json
    {workspace}/02_retrieval/selected_paper.json
    {workspace}/03_process/paper_cards.json
    {workspace}/05_generation/_internal/cite_keys.json

Writes:
    {workspace}/05_generation/_internal/tables_worklist.json
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
from pathlib import Path

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
    log_script_start(ws, "collect_table_specs")

    outline = load_outline(ws.root)
    selected_papers = load_json(ws.selected_papers_path)
    paper_cards = load_json(ws.paper_cards_path)
    cite_keys = load_json(ws.cite_keys_path())

    if ws.query_meta_path().exists():
        query_meta = load_json(ws.query_meta_path())
    else:
        query = __import__("task_contract").read_query(ws.input.parent)
        query_meta = read_query_meta(query, outline)
    language = query_meta.get("language", "english")

    items: list[dict] = []
    for parent, sec in iter_all_sections(outline):
        for t in sec.get("tables") or []:
            tid = t.get("table_id") or t.get("id")
            if not tid:
                continue
            paper_ids = t.get("paper_ids") or []
            rows = []
            for pid in paper_ids:
                ck = cite_keys.get(pid)
                if not ck:
                    continue
                rows.append({
                    "cite_key": ck,
                    "paperId": pid,
                    **format_paper_card(paper_cards.get(pid), selected_papers.get(pid, {})),
                })
            items.append({
                "table_id": tid,
                "label": f"tab:{tid}",
                "caption": t.get("caption_draft", ""),
                "language": language,
                "section_id": sec.get("section_id"),
                "section_title": sec.get("title"),
                "section_description": sec.get("description"),
                "papers": rows,
                "existing_table": (ws.tables_dir / f"{tid}.tex").exists(),
            })

    write_json(ws.tables_worklist_path(), {"language": language, "items": items})
    write_status(
        ws, "collect_table_specs", "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        language=language,
        items=len(items),
        already_written=sum(1 for it in items if it["existing_table"]),
        worklist_path=str(ws.tables_worklist_path()),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
