#!/usr/bin/env scholarseed-skill-python
"""Render an indented outline with captions under their owning sections.

Paper assignments, rationale and planning details remain internal.
Writing approval policy is owned by writing_request.json, not this renderer.
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
# --- end slr path bootstrap ---

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

TITLE_CLIP = 90


def load_titles(workspace: Path) -> dict[str, str]:
    """paper_id -> title, under every id spelling the outline might have used.

    `validate_outline.py` accepts only the card key and its `paperId` copy; a
    cite key written into `paper_ids` is a contract violation there and is
    rejected with an instruction. This renderer still resolves cite keys, for a
    different job: it renders the page a *human* reads, and a reader is better
    served by seeing which papers a section is about than by a column of "no
    card with this id". The validator is what refuses the outline; this is what
    explains it.
    """
    path = workspace / "03_process" / "paper_cards.json"
    if not path.is_file():
        return {}
    try:
        cards = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(cards, dict):
        return {}

    cite_keys: dict[str, str] = {}
    keys_path = workspace / "03_process" / "cite_keys.json"
    if keys_path.is_file():
        try:
            raw_keys = json.loads(keys_path.read_text(encoding="utf-8"))
            if isinstance(raw_keys, dict):
                cite_keys = {str(k): str(v) for k, v in raw_keys.items() if v}
        except (json.JSONDecodeError, OSError):
            cite_keys = {}

    titles: dict[str, str] = {}
    for pid, raw in cards.items():
        raw = raw or {}
        title = str(raw.get("title") or "").strip()
        year = raw.get("year")
        label = f"{title} ({year})" if title and year else title or pid
        for key in (pid, raw.get("paperId"), cite_keys.get(str(pid))):
            if key:
                titles[str(key)] = label
    return titles


def _clip(text: str, limit: int = TITLE_CLIP) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _paper_lines(pids: list, titles: dict[str, str]) -> list[str]:
    lines = []
    for pid in pids:
        known = titles.get(str(pid))
        if known:
            lines.append(f"    - {_clip(known)}")
        else:
            # Not silently swallowed: an id with no card behind it is exactly
            # what breaks drafting later, and this page is the cheapest place
            # to notice it.
            lines.append(f"    - `{pid}` — **no card with this id**")
    return lines


def render(outline: dict, titles=None, rationale=None) -> str:
    """Display only the hierarchy and captions; retain planning detail in JSON."""
    title=" ".join(str(outline.get('survey_title') or outline.get('topic') or 'Outline').split())
    chinese=any('\u3400' <= c <= '\u9fff' for c in title + str(outline.get('outline_tree',[])))
    figure_label,table_label=('图','表') if chinese else ('Figure','Table')
    lines=['**'+title+'**','']
    def assets(node,depth):
        for kind,id_key,label in [('figures','figure_id',figure_label),('tables','table_id',table_label)]:
            for asset in node.get(kind,[]) or []:
                caption=' '.join(str(asset.get('caption_draft') or asset.get('caption') or '').split())
                lines.append('    '*depth+'- '+label+' '+str(asset.get(id_key,''))+': '+caption)
    def node(item,depth):
        name=' '.join(str(item.get('title') or '').split())
        language=str(item.get('language') or 'default').strip().lower()
        language_note='' if depth or language=='default' else ' [language: '+language+']'
        lines.append('    '*depth+'- '+str(item.get('section_id','')).strip()+' '+name+language_note)
        assets(item,depth+1)
        for child in item.get('subsections',[]) or []:node(child,depth+1)
    tree=outline.get('outline_tree') or []
    for section in tree:node(section,0)
    if not tree:assets(outline,0)
    return '\n'.join(lines)+'\n'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("workspace", nargs="?", default=".", help="run workspace (default: cwd)")
    ap.add_argument("--stdout", action="store_true",
                    help="print instead of writing 04_outline/outline.md")
    args = ap.parse_args()

    workspace = Path(args.workspace).resolve()
    outline_path = workspace / "04_outline" / "outline.json"
    if not outline_path.is_file():
        print(f"[FAIL] outline.json not found at {outline_path}", file=sys.stderr)
        return 2
    try:
        from writing_contract import load_outline
        outline = load_outline(workspace)
    except (ValueError, OSError) as exc:
        print(f"[FAIL] outline.json is not readable JSON: {exc}", file=sys.stderr)
        return 2

    text = render(outline)

    if args.stdout:
        print(text)
        return 0

    target = workspace / "04_outline" / "outline.md"
    target.write_text(text, encoding="utf-8")
    print(f"[OK] wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
