#!/usr/bin/env scholarseed-skill-python
"""
build_cards_index.py — a one-line-per-paper view of the corpus, for agents.

Why this exists
---------------
`03_process/paper_cards.json` is the evidence base, and it is enormous:
roughly 6.7 KB per paper, so a 150-paper corpus runs to a megabyte — well over
200k tokens. An agent that opens it to answer "what is actually in this corpus?"
has spent its whole context window before it has thought about anything.

`03_process/cards_index.jsonl` is what the orchestrating agent and every
subagent should read instead. One compact JSON line per paper carries the
identity (paper_id, cite_key), the metadata a human recognises a paper by
(title, year, venue, first author), the three routing fields (tier,
relevance_level, paper_type), whether it was read in full, and two ~300-char
summaries. That is around a tenth of the tokens — a ~90% saving — and it is
enough to decide *which* papers to then open the full card for. Nothing here
replaces `paper_cards.json`; it replaces *scanning* `paper_cards.json`.

JSONL rather than JSON on purpose: an agent can `grep` it, `head` it, or read
the twelve lines it cares about, none of which is possible with a pretty-printed
object.

Also written
------------
`03_process/corpus_summary.json` — the aggregate view: counts by year, by
paper_type and by relevance_level, full-text coverage, and the number of papers
whose card extraction failed or came back empty. That last count is the one to
look at before the outline stage; a corpus where twenty cards are empty is
twenty papers the drafter cannot say anything about, and it does not otherwise
announce itself.

Usage
-----
    scholarseed-skill-python scripts/processing/build_cards_index.py <workspace>

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
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
import json
import os
from collections import Counter
from pathlib import Path

RETRIEVAL_DIR = "02_retrieval"
PROCESS_DIR = "03_process"
SELECTED_FILENAME = "selected_paper.json"
CARDS_FILENAME = "paper_cards.json"
CITE_KEYS_FILENAME = "cite_keys.json"
REPORT_FILENAME = "fulltext_report.json"
INDEX_FILENAME = "cards_index.jsonl"
SUMMARY_FILENAME = "corpus_summary.json"

# Long enough to tell two papers apart, short enough that 150 of them still fit
# in a prompt alongside everything else the agent is holding.
SUMMARY_CHARS = 300

# Below this share of papers carrying a usable card, the corpus is degraded
# enough that the agent should be told before the outline is built.
GOOD_CARD_RATE = 0.90


def _fail(reason: str) -> dict:
    return {"status": "FAILED", "task": "CARDS_INDEX", "status_reason": reason}


def _read_json(path: Path) -> tuple[object, str]:
    if not path.is_file():
        return None, ""
    try:
        return json.loads(path.read_text(encoding="utf-8")), ""
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"{path.name} unreadable: {exc}"


def truncate(value: object, limit: int = SUMMARY_CHARS) -> str:
    """Flatten to a single-line string and cut to `limit` characters.

    Newlines go first: one paper must stay one line, or the file stops being
    readable with `head` / `grep`, which is most of the point of JSONL.
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = "; ".join(str(v) for v in value if v)
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def authors_short(meta: dict) -> str:
    """First author, plus " et al." when there is more than one."""
    authors = meta.get("authors") or []
    if not isinstance(authors, list) or not authors:
        return ""
    first = authors[0]
    name = (first.get("name") if isinstance(first, dict) else str(first)) or ""
    name = " ".join(str(name).split())
    if not name:
        return ""
    return f"{name} et al." if len(authors) > 1 else name


def venue_name(meta: dict) -> str:
    venue = meta.get("venue")
    if isinstance(venue, dict):
        return truncate(venue.get("name") or "", 120)
    if isinstance(venue, str):
        return truncate(venue, 120)
    return truncate(meta.get("journal") or "", 120)


def card_is_empty(card_entry: dict | None) -> bool:
    """A card that carries neither structured content nor a tldr.

    Both halves matter. `card` is the paper-type-specific body and `tldr` is the
    one line every card shape has; a paper missing both is one the drafting
    stage has nothing to quote from, whether the extraction errored or the model
    returned an empty object.
    """
    if not card_entry:
        return True
    if card_entry.get("card"):
        return False
    common = card_entry.get("common_fields")
    if isinstance(common, dict) and (common.get("tldr") or common.get("core_contribution")):
        return False
    return True


def fulltext_flags(cards: dict, report: dict | None) -> dict[str, bool]:
    """paper_id -> whether the extractor had more than the abstract.

    `has_parse_dict` on the card is the authoritative answer, because it records
    what `run_pipeline` actually fed the model. `reading_depth` is deliberately
    NOT used as a proxy: an L3 paper is read as `metadata_only` even when its
    full text was fetched, so that field measures the reading policy, not
    availability. `fulltext_report.json` fills in papers with no card at all.
    """
    flags: dict[str, bool] = {}
    for row in (report or {}).get("papers") or []:
        if not isinstance(row, dict) or not row.get("paper_id"):
            continue
        flags[row["paper_id"]] = bool(row.get("chars") or 0) \
            or str(row.get("outcome") or "").startswith("ok_")
    for pid, entry in cards.items():
        if isinstance(entry, dict) and isinstance(entry.get("has_parse_dict"), bool):
            flags[pid] = entry["has_parse_dict"]
    return flags


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def build(workspace: Path) -> tuple[dict, dict]:
    retrieval = workspace / RETRIEVAL_DIR
    process = workspace / PROCESS_DIR

    selected, err = _read_json(retrieval / SELECTED_FILENAME)
    if err:
        return {}, _fail(err)
    if not isinstance(selected, dict) or not selected:
        return {}, _fail(f"{retrieval / SELECTED_FILENAME} is missing or empty — "
                         f"run the retrieval stage first")
    papers = {pid: meta for pid, meta in selected.items() if isinstance(meta, dict)}

    cards, err = _read_json(process / CARDS_FILENAME)
    if err:
        return {}, _fail(err)
    cards = cards if isinstance(cards, dict) else {}

    cite_keys, err = _read_json(process / CITE_KEYS_FILENAME)
    if err:
        return {}, _fail(err)
    # Absent only when build_bib.py has not run. The index still has value
    # without cite keys, so this degrades rather than fails — but it is worth a
    # PARTIAL_SUCCESS, since a subagent reading a keyless index cannot cite.
    cite_keys = cite_keys if isinstance(cite_keys, dict) else {}

    report, _ = _read_json(retrieval / REPORT_FILENAME)
    report = report if isinstance(report, dict) else None
    has_text = fulltext_flags(cards, report)

    lines: list[str] = []
    years: Counter = Counter()
    types: Counter = Counter()
    levels: Counter = Counter()
    tiers: Counter = Counter()
    with_fulltext = 0
    empty_cards: list[str] = []
    fulltext_by_level: dict[str, dict] = {}

    for pid in sorted(papers):
        meta = papers[pid]
        card_entry = cards.get(pid) if isinstance(cards.get(pid), dict) else None
        common = (card_entry or {}).get("common_fields")
        common = common if isinstance(common, dict) else {}

        level = card_entry.get("relevance_level") if card_entry else None
        level = level or meta.get("relevance_level") or "unknown"
        paper_type = (card_entry or {}).get("paper_type") or meta.get("paper_type") or "unknown"
        year = (card_entry or {}).get("year") or meta.get("year")
        fulltext = bool(has_text.get(pid))

        row = {
            "paper_id": pid,
            "cite_key": cite_keys.get(pid, ""),
            "title": truncate(meta.get("title") or (card_entry or {}).get("title"), 300),
            "year": year,
            "venue": venue_name(meta),
            "authors_short": authors_short(meta),
            "tier": meta.get("tier", ""),
            "relevance_level": level,
            "paper_type": paper_type,
            "reading_depth": (card_entry or {}).get("reading_depth", ""),
            "has_fulltext": fulltext,
            "tldr": truncate(common.get("tldr")),
            "core_contribution": truncate(common.get("core_contribution")),
        }
        lines.append(json.dumps(row, ensure_ascii=False))

        years[str(year) if year else "unknown"] += 1
        types[paper_type] += 1
        levels[level] += 1
        tiers[str(meta.get("tier") or "unknown")] += 1
        bucket = fulltext_by_level.setdefault(level, {"total": 0, "with_fulltext": 0})
        bucket["total"] += 1
        if fulltext:
            with_fulltext += 1
            bucket["with_fulltext"] += 1
        if card_is_empty(card_entry):
            empty_cards.append(pid)

    _write_atomic(process / INDEX_FILENAME, "\n".join(lines) + "\n")

    total = len(papers)
    for bucket in fulltext_by_level.values():
        bucket["coverage"] = round(bucket["with_fulltext"] / bucket["total"], 3) \
            if bucket["total"] else 0.0

    summary = {
        "total_papers": total,
        "cards_present": sum(1 for pid in papers if pid in cards),
        "cards_missing_or_empty": len(empty_cards),
        # Capped: this is a summary, and a corpus where every card failed would
        # otherwise put the entire paper_id list into the agent's context.
        "cards_missing_or_empty_ids": empty_cards[:25],
        "card_rate": round((total - len(empty_cards)) / total, 3) if total else 0.0,
        "with_fulltext": with_fulltext,
        "fulltext_coverage": round(with_fulltext / total, 3) if total else 0.0,
        "fulltext_by_relevance_level": dict(sorted(fulltext_by_level.items())),
        "by_year": dict(sorted(years.items())),
        "by_paper_type": dict(sorted(types.items())),
        "by_relevance_level": dict(sorted(levels.items())),
        "by_tier": dict(sorted(tiers.items())),
        "cite_keys_present": sum(1 for pid in papers if cite_keys.get(pid)),
        "index_path": str(process / INDEX_FILENAME),
    }
    _write_atomic(process / SUMMARY_FILENAME,
                  json.dumps(summary, ensure_ascii=False, indent=2) + "\n")

    reasons: list[str] = []
    if not cite_keys:
        reasons.append(f"{CITE_KEYS_FILENAME} not found; index rows carry no cite_key "
                       f"— run build_bib.py")
    if empty_cards:
        reasons.append(f"{len(empty_cards)}/{total} paper(s) have no usable card")
    if summary["card_rate"] < GOOD_CARD_RATE or reasons:
        return summary, {
            "status": "PARTIAL_SUCCESS", "task": "CARDS_INDEX",
            "status_reason": "; ".join(reasons) or
                             f"card rate {summary['card_rate']:.0%} is below "
                             f"{GOOD_CARD_RATE:.0%}",
        }
    return summary, {
        "status": "SUCCESS", "task": "CARDS_INDEX",
        "status_reason": f"{total} papers indexed; {with_fulltext} with full text "
                         f"({summary['fulltext_coverage']:.0%})",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace directory holding 02_retrieval/ (default: cwd)")
    ap.add_argument("--json", action="store_true",
                    help="print the whole corpus summary rather than the status line")
    args = ap.parse_args()

    summary, status = build(Path(args.workspace).resolve())

    if args.json:
        print(json.dumps({**status, "summary": summary}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({
            **status,
            "total_papers": summary.get("total_papers"),
            "cards_missing_or_empty": summary.get("cards_missing_or_empty"),
            "fulltext_by_relevance_level": summary.get("fulltext_by_relevance_level"),
            "by_paper_type": summary.get("by_paper_type"),
        }, indent=2, ensure_ascii=False))
    return 0 if status["status"] in ("SUCCESS", "PARTIAL_SUCCESS") else 1


if __name__ == "__main__":
    raise SystemExit(main())
