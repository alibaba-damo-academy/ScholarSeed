"""Phase 0 — Bootstrap.

Validates the four contracted input files in the workspace, ensures all output
directories exist, and persists a paper_id -> cite_key map for downstream
phases.

Usage:
    scholarseed-skill-python scripts/generation/_fast/phase00_bootstrap.py --workspace <path>
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

sys.path.insert(0, str(Path(__file__).parent))
from writing_contract import load_outline, require_approval
from _utils import (  # noqa: E402
    Workspace,
    build_cite_key_map,
    iter_leaf_sections,
    load_json,
    log_debug,
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
    log_script_start(ws, "phase00_bootstrap")

    # ----- Validate inputs -----
    missing = [
        str(path)
        for path in (ws.query_path, ws.selected_papers_path, ws.paper_cards_path, ws.outline_path)
        if not path.exists()
    ]
    if missing:
        write_status(
            ws,
            "phase00_bootstrap",
            "FAILED",
            duration_sec=round(time.time() - started, 2),
            missing_inputs=missing,
            message="One or more required input files are missing.",
        )
        return 2

    query = __import__("task_contract").read_query(ws.input.parent)
    selected_papers = load_json(ws.selected_papers_path)
    paper_cards = load_json(ws.paper_cards_path)
    require_approval(ws.root)
    outline = load_outline(ws.root)

    log_debug(ws, "phase00_bootstrap",
              f"loaded inputs: papers={len(selected_papers) if isinstance(selected_papers, dict) else '?'}, "
              f"cards={len(paper_cards) if isinstance(paper_cards, dict) else '?'}, "
              f"outline_tree={len(outline.get('outline_tree', [])) if isinstance(outline, dict) else '?'}")

    # ----- Sanity checks -----
    warnings: list[str] = []
    if not isinstance(selected_papers, dict) or not selected_papers:
        write_status(
            ws,
            "phase00_bootstrap",
            "FAILED",
            duration_sec=round(time.time() - started, 2),
            message="selected_paper.json is empty or not an object.",
        )
        return 2
    if "outline_tree" not in outline or (not outline["outline_tree"] and not outline.get("description")):
        write_status(
            ws,
            "phase00_bootstrap",
            "FAILED",
            duration_sec=round(time.time() - started, 2),
            message="outline.json is missing outline_tree or it is empty.",
        )
        return 2

    leaves = list(iter_leaf_sections(outline))
    if not leaves and not outline.get("description"):
        write_status(
            ws,
            "phase00_bootstrap",
            "FAILED",
            duration_sec=round(time.time() - started, 2),
            message="outline_tree contains no leaf sections.",
        )
        return 2

    # Cards may not cover every selected paper; that's OK, we degrade to abstract.
    missing_cards = [pid for pid in selected_papers if pid not in paper_cards]
    if missing_cards:
        warnings.append(f"{len(missing_cards)} selected paper(s) lack paper_cards; will fall back to abstract.")
        log_debug(ws, "phase00_bootstrap", f"papers missing cards: {missing_cards[:10]}")

    # ----- Build cite_key map -----
    # The processing stage already committed to a key per paper in
    # `03_process/cite_keys.json` (scripts/processing/build_bib.py), and the
    # outline and every section draft were written against those keys. Adopt
    # them verbatim; only papers absent from that file get a fresh key. A key
    # that shifts here would turn every `\cite{}` written before the shift into
    # a dangling reference, and nothing downstream would notice until the
    # bibliography came out short.
    upstream_cite_keys_path = ws.process / "cite_keys.json"
    upstream_cite_keys: dict = {}
    cite_keys_source = "derived"
    if upstream_cite_keys_path.exists():
        try:
            loaded = load_json(upstream_cite_keys_path)
            if isinstance(loaded, dict):
                upstream_cite_keys = loaded
                cite_keys_source = "03_process/cite_keys.json"
        except (OSError, ValueError) as exc:
            warnings.append(f"03_process/cite_keys.json unreadable ({exc}); "
                            f"cite keys recomputed from selected_paper.json.")
    else:
        warnings.append("03_process/cite_keys.json not found; cite keys computed here. "
                        "Any \\cite{} written before this point may not match.")

    cite_keys = build_cite_key_map(selected_papers, paper_cards,
                                   preassigned=upstream_cite_keys)
    adopted = sum(1 for pid, ck in cite_keys.items()
                  if upstream_cite_keys.get(pid) == ck)
    if upstream_cite_keys and adopted < len(upstream_cite_keys):
        # Every key in the upstream file that is not in the final map belongs to
        # a paper that is no longer selected. Harmless, but worth surfacing:
        # the alternative explanation is that the corpus changed under the run.
        warnings.append(
            f"{len(upstream_cite_keys) - adopted} cite key(s) in 03_process/cite_keys.json "
            f"are for papers no longer in selected_paper.json.")
    ws.ensure_output_dirs()
    write_json(ws.cite_keys_path(), cite_keys)

    # ----- Resolve query meta (scope / topic / task_id) -----
    meta = read_query_meta(query, outline)
    write_json(ws.internal_dir / "query_meta.json", meta)

    # ----- Audit upstream paper-metadata completeness for citations -----
    bibtex_present = sum(
        1
        for p in selected_papers.values()
        if isinstance(p, dict)
        and isinstance(p.get("citationStyles"), dict)
        and (p.get("citationStyles") or {}).get("bibtex")
    )
    bibtex_missing = len(selected_papers) - bibtex_present
    if bibtex_missing:
        warnings.append(
            f"{bibtex_missing} paper(s) lack citationStyles.bibtex; phase 5 will synthesise BibTeX from authors/year/title."
        )

    # ----- Build leaf section index for downstream consumption -----
    leaf_index = []
    prev_id = None
    leaf_dicts = [(parent, leaf) for parent, leaf in leaves]
    for i, (parent, leaf) in enumerate(leaf_dicts):
        next_id = leaf_dicts[i + 1][1]["section_id"] if i + 1 < len(leaf_dicts) else None
        leaf_index.append({
            "section_id": leaf["section_id"],
            "title": leaf.get("title", ""),
            "description": leaf.get("description", ""),
            "paper_ids": leaf.get("paper_ids", []),
            "parent_id": parent.get("section_id") if parent else None,
            "parent_title": parent.get("title") if parent else None,
            "parent_description": parent.get("description") if parent else None,
            "prev_section_id": prev_id,
            "next_section_id": next_id,
        })
        prev_id = leaf["section_id"]
    write_json(ws.internal_dir / "leaf_index.json", leaf_index)

    write_status(
        ws,
        "phase00_bootstrap",
        "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        topic=meta["topic"],
        survey_title=meta["survey_title"],
        task_id=meta["task_id"],
        scope=meta["scope"],
        language=meta["language"],
        leaves=len(leaves),
        cite_keys_source=cite_keys_source,
        cite_keys_adopted=adopted,
        selected_papers=len(selected_papers),
        cards=len(paper_cards),
        bibtex_present=bibtex_present,
        bibtex_missing=bibtex_missing,
        warnings=warnings,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
