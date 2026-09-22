#!/usr/bin/env scholarseed-skill-python
"""Compatibility corpus-digest CLI. Current outline generation uses evidence.py.

Paper IDs and citation keys remain distinct; this helper is also named by
outline-validation diagnostics. It is not an instruction to dispatch an architect."""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths  # noqa: E402
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402


# ============================================================================
# Paper Cards Digest Builder
# ============================================================================

STR_LIMIT = 500


def _trim_str(s, limit: int = STR_LIMIT):
    if s is None:
        return ""
    s = str(s).strip()
    if len(s) > limit:
        return s[:limit - 1] + "…"
    return s


def _quota_select(cards: dict, max_cards: int) -> list[tuple[str, dict]]:
    """Simplified quota selection: L1 first, then L2, then L3, capped at max_cards."""
    surveys = []
    l1 = []
    l2 = []
    l3 = []
    for pid, v in (cards or {}).items():
        v = v or {}
        pt = v.get("paper_type")
        rl = v.get("relevance_level")
        if pt == "survey":
            surveys.append((pid, v))
        elif rl == "L1":
            l1.append((pid, v))
        elif rl == "L2":
            l2.append((pid, v))
        else:
            l3.append((pid, v))

    survey_cap = max(1, int(len(cards) * 0.5))
    selected = surveys[:survey_cap] + l1 + l2 + l3
    return selected[:max_cards]


def load_cite_keys(workspace: Path) -> tuple[dict, str]:
    """`{paper_id: cite_key}` and a note describing where it came from.

    `03_process/cite_keys.json` is the authority — `build_bib.py` writes it and
    `05_generation` reads the same map, so anything derived here would be a
    second opinion on a question that already has an answer.

    `cards_index.jsonl` carries the same pairs and is the fallback for a
    workspace whose `cite_keys.json` was lost but whose index survived. When
    neither exists the caller falls back to labelling the paper id, and the note
    is printed rather than swallowed: an older workspace still produces a usable
    digest, but the architect should know the cite column is not real.
    """
    keys_path = workspace / "03_process" / "cite_keys.json"
    if keys_path.is_file():
        try:
            data = json.loads(keys_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data:
                return ({str(k): str(v) for k, v in data.items() if v},
                        f"cite keys from {keys_path.name} ({len(data)} papers)")
        except (json.JSONDecodeError, OSError) as exc:
            return {}, f"NOTE: {keys_path.name} is unreadable ({exc})"

    index_path = workspace / "03_process" / "cards_index.jsonl"
    if index_path.is_file():
        pairs: dict[str, str] = {}
        try:
            for line in index_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if row.get("paper_id") and row.get("cite_key"):
                    pairs[str(row["paper_id"])] = str(row["cite_key"])
        except (json.JSONDecodeError, OSError):
            pairs = {}
        if pairs:
            return pairs, (f"NOTE: cite_keys.json absent; cite keys recovered "
                           f"from {index_path.name} ({len(pairs)} papers)")

    return {}, ("NOTE: neither 03_process/cite_keys.json nor cards_index.jsonl "
                "was found, so no real cite keys exist for this corpus. The "
                "`cite:` column below repeats the paper id — it is NOT what "
                "\\cite{} will spell. Run "
                "`scholarseed-skill-python scripts/processing/build_bib.py <workspace>` to mint "
                "them. Nothing about the outline changes: paper_ids are what "
                "the outline carries either way.")


def _as_text(value, limit: int = STR_LIMIT, max_items: int = 3) -> str:
    """One readable line out of a card value, whatever shape it arrived in.

    Extraction writes some of these fields as a string and some as a list, and
    which one you get varies by paper. A digest that only handled strings
    silently dropped every list-valued limitation.
    """
    if isinstance(value, (list, tuple)):
        parts = [str(v).strip() for v in value[:max_items] if str(v or "").strip()]
        return _trim_str("; ".join(parts), limit)
    if isinstance(value, dict):
        return ""
    return _trim_str(value, limit)


def build_paper_cards_text(cards: dict, max_cards: int = 150,
                           cite_keys: dict | None = None
                           ) -> tuple[str, str, list[str]]:
    """Build formatted text of paper cards + survey skeletons for the prompt.

    Returns (paper_cards_text, survey_skeletons_text, paper_id_whitelist).

    The whitelist is **paper ids**, not cite keys — see the module docstring.
    Each entry leads with the paper id for that reason; the cite key rides along
    as an annotation so the rationale can name papers readably.

    Which fields, and why not the abstract
    --------------------------------------
    This used to print each paper's abstract, hard-truncated to 500 characters.
    Measured on a 40-paper corpus that was 20,000 of the digest's 44,712 bytes —
    45% of everything the architect read — and every one of them ended mid
    sentence, on a `…`. An abstract is also the *paper's* framing of itself,
    which is the framing the architect is supposed to be seeing past.

    What it prints instead is the extraction's own judgement, which is already
    on the card and was going unused: `card.problem`, `card.idea`,
    `card.method.name` / `.novelty`, plus tldr and core contribution. Those
    answer the question the architect is actually asking — what is this paper,
    and what is new in it — in about the same number of bytes, and they answer
    it in whole sentences.

    Survey papers additionally print `card.summary.taxonomy`,
    `summary.key_themes` and `card.analysis.trends`: how a published survey of
    this field says the field divides. That is raw material of the best kind
    available here — not a proposed spine, but the spines that already exist in
    print, to be adopted, cut across or argued with.
    """
    selected = _quota_select(cards, max_cards)
    cite_keys = cite_keys or {}

    paper_lines = []
    skeleton_lines = []
    whitelist = []

    for pid, raw in selected:
        raw = raw or {}
        cf = raw.get("common_fields") or {}
        inner = raw.get("card") or {}
        # The card key is the identity every other stage indexes on; `paperId`
        # is a copy of it. Prefer the key so a card whose `paperId` field drifted
        # cannot hand out an id that resolves to nothing.
        paper_id = str(pid or raw.get("paperId") or "")
        cite_key = cite_keys.get(paper_id) or cite_keys.get(str(raw.get("paperId") or "")) \
            or raw.get("cite_key") or paper_id
        title = _trim_str(raw.get("title"), 300)
        paper_type = str(raw.get("paper_type") or "").strip()

        whitelist.append(paper_id)

        head = f"- **{paper_id}** (cite: {cite_key}, year: {raw.get('year', '?')}"
        head += f", {paper_type}): {title}" if paper_type else f"): {title}"
        parts = [head]

        def add(label: str, value, limit: int = STR_LIMIT, max_items: int = 3) -> None:
            text = _as_text(value, limit, max_items)
            if text:
                parts.append(f"  {label}: {text}")

        add("Problem", inner.get("problem"), 320)
        add("Idea", inner.get("idea"), 320)

        method = inner.get("method") or {}
        if isinstance(method, dict) and (method.get("name") or method.get("novelty")):
            name = _trim_str(method.get("name"), 120)
            novelty = _trim_str(method.get("novelty"), 320)
            parts.append(f"  Method: {' — '.join(x for x in (name, novelty) if x)}")

        dataset = inner.get("dataset") or {}
        if isinstance(dataset, dict) and (dataset.get("name") or dataset.get("description")):
            name = _trim_str(dataset.get("name"), 120)
            desc = _trim_str(dataset.get("description"), 320)
            parts.append(f"  Benchmark: {' — '.join(x for x in (name, desc) if x)}")

        # A survey in the corpus has already done part of this job in public.
        # `summary.scope` is left out: on every survey card measured it restated
        # the taxonomy line in weaker words.
        summary = inner.get("summary") or {}
        analysis = inner.get("analysis") or {}
        if isinstance(summary, dict):
            add("Taxonomy", summary.get("taxonomy"), 400)
            add("Themes", summary.get("key_themes"), 400, max_items=4)
        if isinstance(analysis, dict):
            add("Trends", analysis.get("trends"), 280)
            add("Open problems", analysis.get("open_problems"), 320, max_items=3)

        # TLDR is a fallback, not a companion. Where `card.idea` exists it says
        # the same thing twice, and printing both cost 10 KB on a 40-paper
        # corpus for no decision the architect could not already make.
        if not _as_text(inner.get("idea")):
            add("TLDR", cf.get("tldr"), 280)
        add("Contribution", cf.get("core_contribution"), 280)
        # What the paper does *not* settle is what a limitations or
        # future-directions section is built out of, and it was not reaching
        # the architect at all before.
        add("Limitations", cf.get("limitations") or (inner.get("discussion") or {}).get("limitations"),
            limit=260, max_items=2)

        paper_lines.append("\n".join(parts))

        # Collect survey_outline_skeletons if present
        skeletons = raw.get("survey_outline_skeletons")
        if skeletons and isinstance(skeletons, list):
            for skel in skeletons[:3]:
                if isinstance(skel, dict):
                    sections = skel.get("sections") or []
                    titles_list = [s.get("title") for s in sections if isinstance(s, dict) and s.get("title")]
                    if titles_list:
                        skeleton_lines.append(f"- {paper_id}: {' → '.join(titles_list[:8])}")
                elif isinstance(skel, str):
                    skeleton_lines.append(f"- {paper_id}: {skel}")

    paper_text = "\n\n".join(paper_lines)
    skeleton_text = "\n".join(skeleton_lines) if skeleton_lines else "(No survey skeletons available)"
    return paper_text, skeleton_text, whitelist


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("workspace", nargs="?", default=".", help="run workspace (default: cwd)")
    ap.add_argument("--max-cards", type=int, default=150,
                    help="cap on papers shown; quota selection keeps the most relevant")
    ap.add_argument("--ids-only", action="store_true",
                    help="print only the allowed paper_ids, one per line — this "
                         "is the citation whitelist for outline.json's paper_ids")
    args = ap.parse_args()

    workspace = Path(args.workspace).resolve()
    cards_path = workspace / "03_process" / "paper_cards.json"
    if not cards_path.is_file():
        print(f"[FAIL] paper_cards.json not found at {cards_path}", file=sys.stderr)
        return 2
    try:
        cards = json.loads(cards_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[FAIL] paper_cards.json is not readable JSON: {exc}", file=sys.stderr)
        return 2

    cite_keys, cite_note = load_cite_keys(workspace)
    paper_text, skeleton_text, whitelist = build_paper_cards_text(
        cards, args.max_cards, cite_keys)

    if args.ids_only:
        # Deliberately silent about the cite-key source: this output is consumed
        # line-by-line as a whitelist, and a note in it would read as an id.
        print("\n".join(whitelist))
        return 0

    print(f"# Corpus digest — {len(whitelist)} of {len(cards)} papers\n")
    print("The bolded token on each line is the **paper_id** — that, and only "
          "that, is what `outline.json` puts in `paper_ids`. `cite:` is the "
          "BibTeX key the finished document will spell; use it in prose or in "
          "outline_rationale.md, never in `paper_ids`.\n")
    if cite_note:
        print(f"{cite_note}\n")
    print(paper_text)
    if skeleton_text and skeleton_text.strip():
        print("\n# Survey skeletons found in the corpus (structural reference only)\n")
        print(skeleton_text)

    # Measure the saving rather than asserting it. The compression ratio moves
    # with corpus size, --max-cards and how verbose the cards are, so a number
    # written into a prompt is stale the moment the corpus changes -- and a
    # reader who is told "~16%" has no way to notice when it is really 60%.
    raw_bytes = len(cards_path.read_bytes())
    digest_bytes = len(paper_text.encode("utf-8")) + len(skeleton_text.encode("utf-8"))
    share = digest_bytes / raw_bytes if raw_bytes else 0.0
    print(f"\n---\nThis digest is {digest_bytes:,} bytes against paper_cards.json's "
          f"{raw_bytes:,} — {share:.0%} of it, for {len(whitelist)} of {len(cards)} "
          f"papers. Open a full card only for a paper you have a specific "
          f"question about; see the agent definition for the per-paper command "
          f"and the quota.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
