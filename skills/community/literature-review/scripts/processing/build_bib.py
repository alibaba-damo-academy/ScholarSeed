#!/usr/bin/env scholarseed-skill-python
"""
build_bib.py — freeze the corpus bibliography and its cite keys, once, early.

Why this exists
---------------
The bibliography used to be built at the very end of the run, inside
`phase05b_insert_assets.py`, from the cite keys that had actually been cited by
then. That works, but it puts the *construction* of a cite key after everything
that has to spell one: the outline names papers, every section draft writes
`\\cite{...}`, and each of those was relying on a key that no file yet owned.

So construction moves here, to the processing stage, and only the *scoping*
stays late. After this script runs, `03_process/cite_keys.json` is the single
answer to "what do I call this paper", and `03_process/references.bib` holds a
rendered entry for every paper in the corpus — not just the cited ones. Later
stages select from it; nothing re-derives it.

The same rendering code, deliberately
-------------------------------------
`build_cite_key_map` and `render_bibtex_entry` are imported from the generation
pipeline's `_utils`, not reimplemented. BibTeX escaping is subtle: it preserves
`$…$` math regions, skips the cite-key header, and leaves URL-family fields
verbatim. A second copy would drift and could make the final document fail to
compile.

Cite-key collisions
-------------------
Two papers by the same first author, in the same year, whose titles start with
the same salient word collide. `build_cite_key_map` resolves that with a letter
suffix, and the first collision gets `…b`, not `…a` — the suffix counter is
incremented before the letter is derived. That is deliberate-by-now behaviour
rather than an off-by-one: every workspace on disk is keyed by it, the keys are
still unique, and `…a` is simply never issued.

Outputs
-------
`03_process/references.bib`   every corpus paper, one BibTeX entry each
`03_process/cite_keys.json`   `{paper_id: cite_key}`

Usage
-----
    scholarseed-skill-python scripts/processing/build_bib.py <workspace>

Exit status: 0 on SUCCESS or PARTIAL_SUCCESS, 1 on FAILED.
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
# bootstrap() puts scripts/generation/_fast on sys.path, which is where the
# shared BibTeX renderer lives. Without it the import below cannot resolve.
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
import json
import os
from collections import Counter
from pathlib import Path

from _utils import build_cite_key_map, parse_bibtex_entries, render_bibtex_entry

RETRIEVAL_DIR = "02_retrieval"
PROCESS_DIR = "03_process"
SELECTED_FILENAME = "selected_paper.json"
CARDS_FILENAME = "paper_cards.json"
BIB_FILENAME = "references.bib"
CITE_KEYS_FILENAME = "cite_keys.json"

HEADER = (
    "% references.bib — every paper in the corpus, one entry each.\n"
    "% Written by scripts/processing/build_bib.py; do not hand-edit, it is\n"
    "% regenerated whenever the processing stage runs. 05_generation/citations.bib\n"
    "% is the cited-only subset selected out of this file.\n"
)


def _fail(reason: str) -> dict:
    return {"status": "FAILED", "task": "BUILD_BIB", "status_reason": reason}


def _read_json(path: Path) -> tuple[dict | None, str]:
    """Load a JSON object, returning (data, error). Missing file -> (None, "")."""
    if not path.is_file():
        return None, ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"{path.name} unreadable: {exc}"
    if not isinstance(data, dict):
        return None, f"{path.name} is not an object keyed by paper_id"
    return data, ""


def _has_upstream_bibtex(meta: dict) -> bool:
    cs = meta.get("citationStyles")
    return isinstance(cs, dict) and bool((cs.get("bibtex") or "").strip())


def _write_atomic(path: Path, text: str) -> None:
    """Replace in one step, so a crash mid-write never leaves a half a .bib
    that the generation stage would happily read as the whole corpus."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def build(workspace: Path) -> tuple[dict, dict]:
    """Render the corpus bibliography. Returns (report, status)."""
    retrieval = workspace / RETRIEVAL_DIR
    process = workspace / PROCESS_DIR

    selected, err = _read_json(retrieval / SELECTED_FILENAME)
    if err:
        return {}, _fail(err)
    if selected is None:
        return {}, _fail(f"{retrieval / SELECTED_FILENAME} not found — "
                         f"run the retrieval stage first")
    papers = {pid: meta for pid, meta in selected.items() if isinstance(meta, dict)}
    if not papers:
        return {}, _fail(f"{SELECTED_FILENAME} contains no papers")

    cards, err = _read_json(process / CARDS_FILENAME)
    if err:
        return {}, _fail(err)
    # Cards are an input, not a requirement. They only add `abstract`, `tldr`,
    # `has_parse_dict` and `reading_depth` fields to each entry; a bibliography
    # built before the cards exist is still a correct bibliography, and the
    # cite keys — the part every later stage depends on — do not move.
    cards_present = cards is not None
    cards = cards or {}

    preassigned, key_error = _read_json(process / CITE_KEYS_FILENAME)
    if key_error: return {}, _fail(key_error)
    cite_keys = build_cite_key_map(papers, cards, preassigned=preassigned or {})

    entries: list[str] = []
    upstream = 0
    synthesised = 0
    no_title: list[str] = []
    no_author: list[str] = []
    for pid in sorted(papers):
        meta = papers[pid]
        cite_key = cite_keys[pid]
        if _has_upstream_bibtex(meta):
            upstream += 1
        else:
            synthesised += 1
            # Only a synthesised entry can lose these; a verbatim upstream
            # bibtex string carries its own author/title regardless of what the
            # top-level metadata says.
            if not (meta.get("title") or "").strip():
                no_title.append(cite_key)
            if not (meta.get("authors") or []):
                no_author.append(cite_key)
        entries.append(render_bibtex_entry(cite_key, meta, card=cards.get(pid)))

    text = HEADER + "\n" + "\n\n".join(entries) + "\n"
    _write_atomic(process / BIB_FILENAME, text)
    _write_atomic(process / CITE_KEYS_FILENAME,
                  json.dumps(cite_keys, ensure_ascii=False, indent=2) + "\n")

    # Read the file back through the same parser `phase05b_insert_assets.py`
    # uses to select from it. Rendering an entry the selector cannot find again
    # would be invisible here and would surface as a `% MISSING` line in the
    # finished bibliography, hours later.
    parsed = parse_bibtex_entries(text)
    unreadable = [ck for ck in cite_keys.values() if ck not in parsed]

    suffixed = sorted(ck for ck in cite_keys.values() if ck[-1:].isalpha()
                      and ck[:-1] in set(cite_keys.values()))
    report = {
        "papers": len(papers),
        "entries": len(entries),
        "cite_keys": len(set(cite_keys.values())),
        "bibtex_upstream": upstream,
        "bibtex_synthesised": synthesised,
        "collision_suffixed": suffixed,
        "cards_present": cards_present,
        "cards_missing": sorted(pid for pid in papers if pid not in cards)[:20],
        "entries_without_title": no_title,
        "entries_without_author": no_author,
        "entries_not_reparseable": unreadable,
        "references_bib": str(process / BIB_FILENAME),
        "cite_keys_json": str(process / CITE_KEYS_FILENAME),
        "by_relevance_level": dict(sorted(Counter(
            (p.get("relevance_level") or "unknown") for p in papers.values()).items())),
    }

    reasons: list[str] = []
    if unreadable:
        # A rendering the selector cannot re-read is a real defect, not a
        # metadata gap — fail loudly rather than shipping a bibliography with
        # holes in it that only appear in the final PDF.
        return report, _fail(
            f"{len(unreadable)} rendered entr(y/ies) could not be parsed back out of "
            f"{BIB_FILENAME} (first: {unreadable[0]}) — the bibliography is not usable")
    if not cards_present:
        reasons.append(f"{CARDS_FILENAME} not found; entries carry no abstract/tldr fields")
    if no_title:
        reasons.append(f"{len(no_title)} paper(s) have no title to render")
    if no_author:
        reasons.append(f"{len(no_author)} paper(s) have no authors; cited as Anonymous")

    if reasons:
        return report, {"status": "PARTIAL_SUCCESS", "task": "BUILD_BIB",
                        "status_reason": "; ".join(reasons)}
    return report, {"status": "SUCCESS", "task": "BUILD_BIB",
                    "status_reason": f"{len(entries)} entries, {len(set(cite_keys.values()))} "
                                     f"cite keys ({upstream} upstream, {synthesised} synthesised)"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace directory holding 02_retrieval/ (default: cwd)")
    ap.add_argument("--json", action="store_true",
                    help="print the full report rather than the status line")
    args = ap.parse_args()

    report, status = build(Path(args.workspace).resolve())

    if args.json:
        print(json.dumps({**status, "report": report}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({
            **status,
            "entries": report.get("entries"),
            "bibtex_upstream": report.get("bibtex_upstream"),
            "bibtex_synthesised": report.get("bibtex_synthesised"),
            "collision_suffixed": report.get("collision_suffixed"),
        }, indent=2, ensure_ascii=False))
    return 0 if status["status"] in ("SUCCESS", "PARTIAL_SUCCESS") else 1


if __name__ == "__main__":
    raise SystemExit(main())
