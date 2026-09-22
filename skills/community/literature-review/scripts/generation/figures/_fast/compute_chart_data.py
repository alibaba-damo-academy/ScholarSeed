#!/usr/bin/env scholarseed-skill-python
"""compute_chart_data.py — derive a survey's chart numbers from its own corpus.

Why this file exists, and why it is separate from the renderer
--------------------------------------------------------------
**The renderer draws; it never computes.** Every number that reaches a chart in
the published survey is derived here, by this script, from the corpus files the
pipeline already wrote — and is handed to `render_chart.py` as a CSV. The
renderer cannot do arithmetic and is never told what the numbers "should" be.

That split is the whole point of the design, not a tidiness preference. A figure
whose numbers were invented by a model in the act of drawing it is
**unverifiable**: nobody downstream — not the reviewer, not the fast-audit
citation gate, not the reader — can trace "31 papers in 2024" back to anything.
Unverifiable numbers in a survey are worse than no figure at all, because a
chart carries more apparent authority than a sentence does. So the figure-
planner agent is forbidden to emit numbers (it emits a *chart spec*: which named
statistic, which chart type, which axis labels), this script computes them, and
the CSV plus its sidecar JSON are the audit trail. Delete the chart and you can
still recompute it; disagree with it and you can open the CSV.

Reads
-----
    {workspace}/03_process/cards_index.jsonl   — one compact row per paper
    {workspace}/03_process/corpus_summary.json — the pre-aggregated counts
    {workspace}/04_outline/outline.json        — only for papers_per_outline_section

`cards_index.jsonl` is the authoritative per-paper source (see
`scripts/processing/build_cards_index.py` for the row shape: paper_id, cite_key,
title, year, venue, authors_short, tier, relevance_level, paper_type,
reading_depth, has_fulltext, tldr, core_contribution). `corpus_summary.json` is
consulted only to cross-check totals, never as the primary source — it is a
derived file and re-deriving from the rows keeps one code path.

Writes
------
    {out_dir}/{basename}.csv        tidy: label,series,value  (one row per point)
    {out_dir}/{basename}.meta.json  what was computed, from how many papers,
                                    from which files, and what was excluded

The CSV is always three columns even for a single-series chart (`series` is the
empty string then), so the renderer has exactly one input shape to parse.

Usage
-----
    scholarseed-skill-python compute_chart_data.py --list
    scholarseed-skill-python compute_chart_data.py --workspace WS --statistic papers_per_year \\
        --out-dir DIR [--basename NAME] [--top-n 12]

Exit status: 0 computed, 1 bad input (missing corpus, unknown statistic,
unreadable file), 2 the statistic produced no rows for this corpus.
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

import argparse  # noqa: E402
import csv  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
from collections import Counter, OrderedDict  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

INDEX_REL = "03_process/cards_index.jsonl"
SUMMARY_REL = "03_process/corpus_summary.json"
OUTLINE_REL = "04_outline/outline.json"

# Default cut for the "top N" statistics. Ten bars is about as many as a
# single-column survey figure can label without the ticks colliding.
DEFAULT_TOP_N = 10

# Labels longer than this are truncated for the axis; the full value stays in
# the CSV, so nothing is lost — only the tick text is shortened.
LABEL_CHARS = 38


class ChartDataError(Exception):
    """Bad input: a source file is missing, unreadable, or the wrong shape."""


class NoDataError(Exception):
    """The statistic is supported but this corpus yields no rows for it."""


# ============================================================================
# Corpus loading
# ============================================================================


class Corpus:
    """The corpus files a statistic may read. Loaded lazily and once."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self._rows: list[dict] | None = None
        self._summary: dict | None = None
        self._outline: dict | None = None
        self.sources: list[str] = []

    @property
    def rows(self) -> list[dict]:
        if self._rows is None:
            path = self.workspace / INDEX_REL
            if not path.is_file():
                raise ChartDataError(
                    f"{INDEX_REL} not found under {self.workspace} — run "
                    f"scripts/processing/build_cards_index.py first"
                )
            rows: list[dict] = []
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ChartDataError(f"{INDEX_REL}:{lineno} is not JSON: {exc}") from exc
                if isinstance(obj, dict):
                    rows.append(obj)
            if not rows:
                raise ChartDataError(f"{INDEX_REL} has no paper rows")
            self._rows = rows
            self.sources.append(INDEX_REL)
        return self._rows

    @property
    def summary(self) -> dict:
        if self._summary is None:
            path = self.workspace / SUMMARY_REL
            if not path.is_file():
                raise ChartDataError(f"{SUMMARY_REL} not found under {self.workspace}")
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                raise ChartDataError(f"{SUMMARY_REL} unreadable: {exc}") from exc
            if not isinstance(data, dict):
                raise ChartDataError(f"{SUMMARY_REL} is not a JSON object")
            self._summary = data
            self.sources.append(SUMMARY_REL)
        return self._summary

    @property
    def outline(self) -> dict:
        if self._outline is None:
            path = self.workspace / OUTLINE_REL
            if not path.is_file():
                raise ChartDataError(
                    f"{OUTLINE_REL} not found under {self.workspace} — this "
                    f"statistic groups papers by the outline's own sections"
                )
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                raise ChartDataError(f"{OUTLINE_REL} unreadable: {exc}") from exc
            if not isinstance(data, dict):
                raise ChartDataError(f"{OUTLINE_REL} is not a JSON object")
            self._outline = data
            self.sources.append(OUTLINE_REL)
        return self._outline


def _clean(value: object, default: str = "unknown") -> str:
    text = " ".join(str(value or "").split())
    return text or default


def _short(text: str, limit: int = LABEL_CHARS) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _year_of(row: dict) -> str:
    """Year as a 4-digit string, or "" when the row has none we can trust."""
    raw = row.get("year")
    if raw in (None, "", "unknown"):
        return ""
    try:
        year = int(str(raw).strip()[:4])
    except (ValueError, TypeError):
        return ""
    # Anything outside this window is metadata corruption, not a publication.
    return str(year) if 1900 <= year <= 2100 else ""


def _counter_rows(counter: Counter, *, sort: str = "value") -> list[tuple[str, str, float]]:
    """(label, series, value) triples from a Counter.

    sort="value" — descending count, ties broken alphabetically (categorical).
    sort="label" — ascending label (chronological / ordinal axes).
    """
    if sort == "label":
        items = sorted(counter.items(), key=lambda kv: kv[0])
    else:
        items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
    return [(label, "", float(count)) for label, count in items]


# ============================================================================
# The statistics. Each returns (rows, extra_meta).
#
# A statistic is a pure function of the corpus files. It never takes a number
# from a caller (only `top_n`, which selects how many computed rows survive),
# and it never accepts a value to plot.
# ============================================================================


def _stat_papers_per_year(corpus: Corpus, top_n: int):
    counts: Counter = Counter()
    undated = 0
    for row in corpus.rows:
        year = _year_of(row)
        if year:
            counts[year] += 1
        else:
            undated += 1
    if not counts:
        raise NoDataError("no paper in the corpus carries a usable year")
    # Fill the gap years so the axis reads as a timeline rather than a list of
    # whichever years happen to be populated.
    years = [int(y) for y in counts]
    for y in range(min(years), max(years) + 1):
        counts.setdefault(str(y), 0)
    return _counter_rows(counts, sort="label"), {
        "papers_undated_excluded": undated,
        "year_range": [min(years), max(years)],
    }


def _stat_cumulative_papers_per_year(corpus: Corpus, top_n: int):
    rows, meta = _stat_papers_per_year(corpus, top_n)
    total = 0.0
    out = []
    for label, series, value in rows:
        total += value
        out.append((label, series, total))
    return out, {**meta, "final_total": total}


def _stat_papers_per_paper_type(corpus: Corpus, top_n: int):
    counts = Counter(_clean(row.get("paper_type")) for row in corpus.rows)
    return _counter_rows(counts), {"distinct_types": len(counts)}


def _stat_papers_per_relevance_level(corpus: Corpus, top_n: int):
    counts = Counter(_clean(row.get("relevance_level")) for row in corpus.rows)
    return _counter_rows(counts, sort="label"), {"distinct_levels": len(counts)}


def _stat_papers_per_tier(corpus: Corpus, top_n: int):
    counts = Counter(_clean(row.get("tier")) for row in corpus.rows)
    return _counter_rows(counts, sort="label"), {"distinct_tiers": len(counts)}


def _stat_papers_per_venue(corpus: Corpus, top_n: int):
    counts: Counter = Counter()
    for row in corpus.rows:
        counts[_short(_clean(row.get("venue"), "preprint / no venue"))] += 1
    ordered = _counter_rows(counts)
    kept = ordered[:top_n]
    dropped = ordered[top_n:]
    meta = {"distinct_venues": len(counts), "venues_beyond_top_n": len(dropped)}
    if dropped:
        meta["papers_in_dropped_venues"] = sum(v for _, _, v in dropped)
    return kept, meta


def _stat_fulltext_coverage_by_relevance_level(corpus: Corpus, top_n: int):
    """Two series per level: papers read in full vs. abstract-only.

    This is the one chart a survey's own methods section usually has to justify,
    and it is exactly the thing a model would otherwise guess at.
    """
    full: Counter = Counter()
    abstract: Counter = Counter()
    for row in corpus.rows:
        level = _clean(row.get("relevance_level"))
        if row.get("has_fulltext"):
            full[level] += 1
        else:
            abstract[level] += 1
    levels = sorted(set(full) | set(abstract))
    if not levels:
        raise NoDataError("no relevance levels present in the corpus")
    rows = []
    for level in levels:
        rows.append((level, "full text", float(full.get(level, 0))))
        rows.append((level, "abstract only", float(abstract.get(level, 0))))
    return rows, {
        "levels": levels,
        "with_fulltext": sum(full.values()),
        "abstract_only": sum(abstract.values()),
    }


def _stat_paper_type_by_year(corpus: Corpus, top_n: int):
    """Publication year on the x axis, one series per paper type.

    The honest form of "benchmark / dataset coverage over time": `paper_type` is
    a field the card extractor already assigned per paper, so the split is
    recorded data rather than a judgement made at drawing time.
    """
    grid: Counter = Counter()
    types: Counter = Counter()
    undated = 0
    for row in corpus.rows:
        year = _year_of(row)
        if not year:
            undated += 1
            continue
        ptype = _clean(row.get("paper_type"))
        grid[(year, ptype)] += 1
        types[ptype] += 1
    if not grid:
        raise NoDataError("no dated paper carries a paper_type")
    # Cap the number of series: a legend with fifteen entries is unreadable and
    # will fail the renderer's legend-overlap QC anyway.
    kept_types = [t for t, _ in types.most_common(max(1, min(top_n, 6)))]
    years = sorted({y for y, _ in grid})
    rows = []
    for year in years:
        for ptype in kept_types:
            rows.append((year, ptype, float(grid.get((year, ptype), 0))))
    return rows, {
        "series_kept": kept_types,
        "series_dropped": [t for t in types if t not in kept_types],
        "papers_undated_excluded": undated,
    }


def _iter_outline_sections(outline: dict):
    for sec in outline.get("outline_tree") or []:
        if not isinstance(sec, dict):
            continue
        subs = [s for s in (sec.get("subsections") or []) if isinstance(s, dict)]
        if subs:
            for sub in subs:
                yield sub
        else:
            yield sec


def _stat_papers_per_outline_section(corpus: Corpus, top_n: int):
    """Papers assigned to each leaf section of the survey's own outline.

    This is the closest thing to "papers per method family" that can be computed
    rather than judged: the outline architect already partitioned the corpus, and
    this counts that partition. It does not invent a taxonomy at drawing time.
    """
    known = {row.get("paper_id") for row in corpus.rows if row.get("paper_id")}
    counts: OrderedDict[str, float] = OrderedDict()
    unknown_ids = 0
    for sec in _iter_outline_sections(corpus.outline):
        title = _short(_clean(sec.get("title") or sec.get("section_id"), "untitled"))
        ids = {p for p in (sec.get("paper_ids") or []) if p}
        unknown_ids += len(ids - known)
        label = title
        dup = 2
        while label in counts:
            label = f"{title} ({dup})"
            dup += 1
        counts[label] = float(len(ids & known))
    if not counts:
        raise NoDataError("the outline has no leaf sections with paper assignments")
    rows = [(label, "", value) for label, value in counts.items()]
    return rows, {
        "sections": len(rows),
        "assignments_not_in_corpus": unknown_ids,
        "papers_assigned": sum(v for _, _, v in rows),
    }


STATISTICS: "OrderedDict[str, dict]" = OrderedDict([
    ("papers_per_year", {
        "fn": _stat_papers_per_year,
        "description": "Number of corpus papers published in each year (gap years filled with 0).",
        "sources": [INDEX_REL],
        "default_chart_type": "bar",
        "value_kind": "count",
        "suggested_x": "Year",
        "suggested_y": "Number of papers",
    }),
    ("cumulative_papers_per_year", {
        "fn": _stat_cumulative_papers_per_year,
        "description": "Running total of corpus papers up to and including each year.",
        "sources": [INDEX_REL],
        "default_chart_type": "line",
        "value_kind": "count",
        "suggested_x": "Year",
        "suggested_y": "Cumulative number of papers",
    }),
    ("papers_per_paper_type", {
        "fn": _stat_papers_per_paper_type,
        "description": "Number of corpus papers per paper_type (method / benchmark / survey / theory / …).",
        "sources": [INDEX_REL],
        "default_chart_type": "barh",
        "value_kind": "count",
        "suggested_x": "Number of papers",
        "suggested_y": "Paper type",
    }),
    ("papers_per_relevance_level", {
        "fn": _stat_papers_per_relevance_level,
        "description": "Number of corpus papers per screening relevance level.",
        "sources": [INDEX_REL],
        "default_chart_type": "bar",
        "value_kind": "count",
        "suggested_x": "Relevance level",
        "suggested_y": "Number of papers",
    }),
    ("papers_per_tier", {
        "fn": _stat_papers_per_tier,
        "description": "Number of corpus papers per retrieval tier.",
        "sources": [INDEX_REL],
        "default_chart_type": "bar",
        "value_kind": "count",
        "suggested_x": "Retrieval tier",
        "suggested_y": "Number of papers",
    }),
    ("papers_per_venue", {
        "fn": _stat_papers_per_venue,
        "description": "Number of corpus papers per publication venue, top N venues only.",
        "sources": [INDEX_REL],
        "default_chart_type": "barh",
        "value_kind": "count",
        "suggested_x": "Number of papers",
        "suggested_y": "Venue",
    }),
    ("fulltext_coverage_by_relevance_level", {
        "fn": _stat_fulltext_coverage_by_relevance_level,
        "description": "Per relevance level, papers read in full text vs. papers read from the abstract only (two series).",
        "sources": [INDEX_REL],
        "default_chart_type": "grouped_bar",
        "value_kind": "count",
        "suggested_x": "Relevance level",
        "suggested_y": "Number of papers",
    }),
    ("paper_type_by_year", {
        "fn": _stat_paper_type_by_year,
        "description": "Papers per year split by paper_type (one series per type, most common types only) — how benchmark / method / survey work is distributed over time.",
        "sources": [INDEX_REL],
        "default_chart_type": "grouped_bar",
        "value_kind": "count",
        "suggested_x": "Year",
        "suggested_y": "Number of papers",
    }),
    ("papers_per_outline_section", {
        "fn": _stat_papers_per_outline_section,
        "description": "Papers assigned to each leaf section of this survey's outline — the corpus split across the survey's own topic families.",
        "sources": [INDEX_REL, OUTLINE_REL],
        "default_chart_type": "barh",
        "value_kind": "count",
        "suggested_x": "Number of papers",
        "suggested_y": "Survey section",
    }),
])

# The name list every other module validates against. `validate_figures_meta.py`
# imports THIS tuple rather than restating it, so a statistic cannot be accepted
# by the validator and then be unknown to the compute step.
SUPPORTED_STATISTICS: tuple[str, ...] = tuple(STATISTICS)


def describe_statistics() -> list[dict]:
    """Agent-readable catalogue: what each statistic is and how to draw it."""
    return [
        {
            "statistic": name,
            "description": spec["description"],
            "sources": spec["sources"],
            "default_chart_type": spec["default_chart_type"],
            "value_kind": spec["value_kind"],
            "suggested_x_label": spec["suggested_x"],
            "suggested_y_label": spec["suggested_y"],
        }
        for name, spec in STATISTICS.items()
    ]


# ============================================================================
# Driver
# ============================================================================


def _now_iso() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def compute(workspace: Path, statistic: str, out_dir: Path,
            basename: str | None = None, top_n: int = DEFAULT_TOP_N) -> dict:
    """Compute `statistic`, write the CSV + sidecar, return the sidecar dict.

    Raises ChartDataError (bad input) or NoDataError (nothing to plot).
    """
    if statistic not in STATISTICS:
        raise ChartDataError(
            f"unknown statistic {statistic!r}; supported: {', '.join(SUPPORTED_STATISTICS)}"
        )
    spec = STATISTICS[statistic]
    corpus = Corpus(workspace)
    rows, extra = spec["fn"](corpus, top_n)
    if not rows:
        raise NoDataError(f"statistic {statistic!r} produced no rows for this corpus")

    out_dir.mkdir(parents=True, exist_ok=True)
    name = basename or statistic
    csv_path = out_dir / f"{name}.csv"
    meta_path = out_dir / f"{name}.meta.json"

    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["label", "series", "value"])
        for label, series, value in rows:
            # Counts are integers; writing 12 rather than 12.0 keeps the CSV
            # readable by a human checking the figure against the corpus.
            out = int(value) if float(value).is_integer() else value
            writer.writerow([label, series, out])

    series_names = [s for s in dict.fromkeys(s for _, s, _ in rows) if s]
    meta = {
        "statistic": statistic,
        "description": spec["description"],
        "computed_by": "scripts/generation/figures/_fast/compute_chart_data.py",
        "computed_at": _now_iso(),
        "workspace": str(workspace),
        "source_files": sorted(set(corpus.sources)),
        "papers_in_corpus": len(corpus._rows) if corpus._rows is not None else None,
        "rows": len(rows),
        "series": series_names,
        "value_kind": spec["value_kind"],
        "value_total": sum(v for _, _, v in rows),
        "default_chart_type": spec["default_chart_type"],
        "suggested_x_label": spec["suggested_x"],
        "suggested_y_label": spec["suggested_y"],
        "top_n": top_n,
        "csv_path": str(csv_path),
        **extra,
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Derive one named chart statistic from the corpus, as a CSV.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="The renderer draws; only this script computes. See the module docstring.",
    )
    ap.add_argument("--list", action="store_true",
                    help="print the supported statistics as JSON and exit")
    ap.add_argument("--workspace", default=".", help="run workspace (default: cwd)")
    ap.add_argument("--statistic", help="name of the statistic to compute")
    ap.add_argument("--out-dir", help="directory to write {basename}.csv and .meta.json into")
    ap.add_argument("--basename", help="output basename (default: the statistic name)")
    ap.add_argument("--top-n", type=int, default=DEFAULT_TOP_N,
                    help=f"cap for the top-N statistics (default: {DEFAULT_TOP_N})")
    args = ap.parse_args()

    if args.list:
        print(json.dumps({"statistics": describe_statistics()},
                         ensure_ascii=False, indent=2))
        return 0

    if not args.statistic or not args.out_dir:
        print("[FAIL] --statistic and --out-dir are required (or pass --list)",
              file=sys.stderr)
        return 1

    try:
        meta = compute(Path(args.workspace).resolve(), args.statistic,
                       Path(args.out_dir).resolve(), args.basename, args.top_n)
    except ChartDataError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    except NoDataError as exc:
        print(f"[EMPTY] {exc}", file=sys.stderr)
        return 2

    print(json.dumps({"status": "OK", **meta}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
