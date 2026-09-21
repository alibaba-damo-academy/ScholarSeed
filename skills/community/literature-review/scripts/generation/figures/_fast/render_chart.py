#!/usr/bin/env scholarseed-skill-python
"""render_chart.py — draw one chart from a CSV. It draws; it never computes.

The contract, and why it is worth enforcing
-------------------------------------------
This renderer takes a CSV produced by `compute_chart_data.py` and turns it into
a PNG plus a vector file. **It performs no arithmetic on the data.** It does not
sum, average, normalise, re-sort, bucket, interpolate or cap anything; row order
in the CSV is the plot order, and the number in the `value` column is the number
that is drawn. The only numbers this file computes are geometry — bar widths,
axis limits, tick positions.

That is deliberate. Every figure in a generated survey has to be traceable back
to the corpus, and the only way to keep that property is to make the drawing
step incapable of inventing a number. A chart whose values were produced in the
act of drawing it cannot be checked by anyone; unverifiable numbers in a survey
are worse than no figure, because a chart is read as evidence. So: statistics
are derived by `compute_chart_data.py` from `03_process/cards_index.jsonl`,
written to a CSV that ships next to the figure, and this file consumes only that
CSV. If a value looks wrong, open the CSV — not this module.

Input CSV (written by compute_chart_data.py), header row required:

    label,series,value

`series` is the empty string for a single-series chart. Blank `series` on some
rows and not others is a malformed file, not a mixed chart.

Output
------
    <--out>            PNG raster — this is what LaTeX \\includegraphics uses and
                       what the Markdown fallback embeds.
    <--vector>         PDF (or PGF) alongside it, for anyone recompiling the
                       bundle at print resolution. Defaults to <--out>.pdf.
    <--meta-out>       JSON record of what was drawn, including the CJK-font
                       decision. Optional but written by the pipeline.

Exit status — distinct on purpose, callers branch on it:
    0   rendered; both files written
    1   bad input (CSV missing / unreadable / wrong columns / unparseable value,
        unknown chart type, unwritable output directory)
    2   QC failure — **no output file is written**, and any stale output at the
        target paths is removed. A figure that fails QC must not ship, and a
        leftover file from a previous run must not be mistaken for this one's.

QC assertions (all must hold):
    * at least one data point
    * no NaN / infinite value
    * the number of points actually drawn equals the number of CSV data rows
    * both axis labels are present and non-empty
    * the legend does not overlap any plotted data

Fonts / CJK
-----------
CJK is the trap here: a machine can have Noto Sans CJK installed and matplotlib
can still render 豆腐 boxes, because matplotlib's font cache is built once and a
font installed afterwards never enters `fontManager.ttflist`. So the probe does
not trust the cache — it rescans the system font files, registers the CJK ones,
and then verifies the chosen face actually has a glyph for a probe ideograph.
Only if that fails does it fall back to English axis labels, and the fallback is
recorded in the figure metadata. Silent tofu is the failure mode this is
designed against.

Two documented fault-injection hooks, used by the tests and by nothing else:
    SLR_CHART_CJK_FONT_CANDIDATES  override the candidate family list; set it to
                                   the empty string to simulate a machine with
                                   no CJK font at all.
    SLR_CHART_FORCE_LEGEND_LOC     force a legend location, to prove the
                                   legend-overlap QC actually fires.

Usage
-----
    scholarseed-skill-python render_chart.py --csv DATA.csv --out FIG.png \\
        --chart-type bar --x-label "Year" --y-label "Number of papers" \\
        [--vector FIG.pdf] [--title T] [--language chinese] \\
        [--x-label-fallback Year] [--y-label-fallback "Number of papers"] \\
        [--meta-out FIG.chart.json]
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
import math  # noqa: E402
import os  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

import matplotlib  # noqa: E402
matplotlib.use("Agg")  # headless: no display on the pipeline host
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager as fm  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402

EXIT_OK = 0
EXIT_BAD_INPUT = 1
EXIT_QC_FAILURE = 2

CHART_TYPES: tuple[str, ...] = ("bar", "barh", "line", "grouped_bar")
VECTOR_SUFFIXES: tuple[str, ...] = (".pdf", ".pgf")

# Fixed house style. No seaborn, no network fonts, no rcParams file — a survey
# figure has to look the same on every machine that runs this pipeline.
FIG_WIDTH_IN = 7.0
FIG_HEIGHT_IN = 4.2
DPI = 200
# Colour-blind-safe categorical ramp (Okabe–Ito), used in order.
PALETTE = ("#0072B2", "#E69F00", "#009E73", "#CC79A7",
           "#56B4E9", "#D55E00", "#F0E442", "#000000")
GRID_KW = {"axis": "y", "linestyle": ":", "linewidth": 0.6, "alpha": 0.6}

# Families worth trying, best first. Overridable for testing; see the docstring.
_DEFAULT_CJK_FAMILIES = (
    "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP",
    "Noto Serif CJK SC", "Source Han Sans SC", "Source Han Serif SC",
    "WenQuanYi Zen Hei", "WenQuanYi Micro Hei", "Droid Sans Fallback",
    "AR PL KaitiM GB", "AR PL SungtiL GB", "AR PL UMing CN",
    "SimHei", "SimSun", "Microsoft YaHei", "PingFang SC", "Heiti SC",
)
# Filename fragments that mark a font file as plausibly CJK — used to keep the
# rescan cheap (opening every system font to read its family name is slow).
_CJK_FILE_HINTS = ("cjk", "wqy", "wenquanyi", "sourcehan", "notosanssc",
                   "notoserifsc", "simhei", "simsun", "msyh", "yahei",
                   "kai", "ming", "sung", "song", "hei", "fangsong",
                   "droidsansfallback", "arphic")
# One common ideograph and one that only a reasonably complete face carries.
_CJK_PROBE_CHARS = ("研", "综")


class BadInput(Exception):
    """Something about the invocation or the CSV is wrong. Exit 1."""


class QCFailure(Exception):
    """The drawing violates a quality assertion. Exit 2, no file written."""

    def __init__(self, checks: list[str]):
        super().__init__("; ".join(checks))
        self.checks = checks


# ============================================================================
# CSV input — read verbatim, never transformed
# ============================================================================


def read_rows(csv_path: Path) -> list[tuple[str, str, float]]:
    """Parse the tidy CSV into (label, series, value) in file order.

    Order is preserved exactly: `compute_chart_data.py` already decided whether
    this axis is chronological or ranked, and re-sorting here would be the
    renderer making a data decision.
    """
    if not csv_path.is_file():
        raise BadInput(f"csv not found: {csv_path}")
    try:
        text = csv_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BadInput(f"csv unreadable: {exc}") from exc

    reader = csv.reader(text.splitlines())
    try:
        header = next(reader)
    except StopIteration:
        raise BadInput(f"csv is empty: {csv_path}") from None
    header = [h.strip().lower() for h in header]
    if header[:3] != ["label", "series", "value"]:
        raise BadInput(
            f"csv header must be 'label,series,value', got {','.join(header) or '(nothing)'}"
        )

    rows: list[tuple[str, str, float]] = []
    for lineno, raw in enumerate(reader, start=2):
        if not raw or all(not c.strip() for c in raw):
            continue
        if len(raw) < 3:
            raise BadInput(f"{csv_path.name}:{lineno} has {len(raw)} column(s), expected 3")
        label, series, value = raw[0].strip(), raw[1].strip(), raw[2].strip()
        try:
            # float() accepts 'nan' / 'inf'; that is intentional. A malformed
            # number is bad input (exit 1); a NaN that parsed fine is a data
            # defect and belongs to QC (exit 2), which checks for it below.
            number = float(value)
        except ValueError as exc:
            raise BadInput(
                f"{csv_path.name}:{lineno} value {value!r} is not a number"
            ) from exc
        rows.append((label, series, number))
    return rows


# ============================================================================
# Fonts
# ============================================================================


def _has_cjk(text: str) -> bool:
    return any(
        0x3000 <= ord(ch) <= 0x303F or 0x3400 <= ord(ch) <= 0x4DBF
        or 0x4E00 <= ord(ch) <= 0x9FFF or 0xF900 <= ord(ch) <= 0xFAFF
        or 0xFF00 <= ord(ch) <= 0xFFEF
        for ch in text or ""
    )


def _cjk_candidates() -> tuple[str, ...]:
    override = os.environ.get("SLR_CHART_CJK_FONT_CANDIDATES")
    if override is None:
        return _DEFAULT_CJK_FAMILIES
    return tuple(f.strip() for f in override.split(",") if f.strip())


def _face_has_glyphs(path: str) -> bool:
    """True when the font file actually carries our probe ideographs.

    A family name containing "CJK" is not proof: subset builds and metric-only
    faces exist, and a missing glyph renders as a tofu box rather than an error.
    """
    try:
        from matplotlib.ft2font import FT2Font
        face = FT2Font(path)
        return all(face.get_char_index(ord(ch)) for ch in _CJK_PROBE_CHARS)
    except Exception:  # noqa: BLE001 — an unreadable face is simply not usable
        return False


def resolve_cjk_font() -> dict:
    """Find a CJK-capable family matplotlib can really draw with.

    Returns {"family": str|None, "path": str|None, "reason": str,
             "rescanned": bool, "candidates": [...]}.

    Step 2 is the load-bearing one: matplotlib builds `fontManager.ttflist` once
    and caches it, so a font installed after that cache was written is invisible
    to `findfont` even though `fc-list` reports it. Rescanning the font
    directories and calling `addfont` is what turns an installed-but-unseen CJK
    font into a usable one.
    """
    candidates = _cjk_candidates()
    info: dict = {"family": None, "path": None, "rescanned": False,
                  "candidates": list(candidates), "reason": ""}
    if not candidates:
        info["reason"] = "no candidate CJK families configured"
        return info

    def _try(names: set[str]) -> bool:
        for family in candidates:
            if family not in names:
                continue
            try:
                path = fm.findfont(fm.FontProperties(family=family),
                                   fallback_to_default=False)
            except Exception:  # noqa: BLE001
                continue
            if _face_has_glyphs(path):
                info["family"] = family
                info["path"] = path
                return True
        return False

    if _try({f.name for f in fm.fontManager.ttflist}):
        info["reason"] = "found in matplotlib's font cache"
        return info

    # Step 2: the cache is stale or was built before the font was installed.
    info["rescanned"] = True
    registered = 0
    for path in fm.findSystemFonts():
        base = os.path.basename(path).lower()
        if not any(hint in base for hint in _CJK_FILE_HINTS):
            continue
        try:
            fm.fontManager.addfont(path)
            registered += 1
        except Exception:  # noqa: BLE001
            continue
    if _try({f.name for f in fm.fontManager.ttflist}):
        info["reason"] = f"registered by rescanning system fonts ({registered} file(s) added)"
        return info

    info["reason"] = (
        f"no CJK-capable font among {len(candidates)} candidate famil(ies); "
        f"{registered} candidate file(s) registered by rescan, none usable"
    )
    return info


def apply_font(font: dict) -> None:
    families = ["DejaVu Sans"]
    if font.get("family"):
        families.insert(0, font["family"])
    matplotlib.rcParams["font.family"] = "sans-serif"
    matplotlib.rcParams["font.sans-serif"] = families
    # A CJK face's U+2212 coverage is unreliable; ASCII hyphen always renders.
    matplotlib.rcParams["axes.unicode_minus"] = False


# ============================================================================
# CJK fallback — replace, never emit tofu
# ============================================================================


def apply_cjk_fallback(text_fields: dict, rows: list[tuple[str, str, float]],
                       fallbacks: dict) -> tuple[dict, list[tuple[str, str, float]], dict]:
    """Swap every CJK string for an ASCII one when no CJK font is available.

    Axis labels and the title fall back to the caller-supplied English strings
    (`--x-label-fallback` etc.). Tick labels and series names come from the
    corpus, so there is no English original to fall back to — those are replaced
    with positional placeholders and the substitution is counted, so the figure
    metadata says plainly that the labels were anonymised rather than pretending
    the chart is fine.
    """
    report = {"fields_replaced": [], "labels_replaced": 0, "series_replaced": 0}

    out_fields = dict(text_fields)
    for key, value in text_fields.items():
        if not _has_cjk(value or ""):
            continue
        replacement = (fallbacks.get(key) or "").strip()
        if replacement and not _has_cjk(replacement):
            out_fields[key] = replacement
        else:
            out_fields[key] = key.replace("_", " ").title()
        report["fields_replaced"].append(key)

    label_map: dict[str, str] = {}
    series_map: dict[str, str] = {}
    for label, series, _ in rows:
        if _has_cjk(label) and label not in label_map:
            label_map[label] = f"item {len(label_map) + 1}"
        if _has_cjk(series) and series not in series_map:
            series_map[series] = f"series {len(series_map) + 1}"
    report["labels_replaced"] = len(label_map)
    report["series_replaced"] = len(series_map)

    out_rows = [
        (label_map.get(label, label), series_map.get(series, series), value)
        for label, series, value in rows
    ]
    return out_fields, out_rows, report


# ============================================================================
# Drawing
# ============================================================================


def _series_order(rows) -> list[str]:
    return list(dict.fromkeys(series for _, series, _ in rows))


def _label_order(rows) -> list[str]:
    return list(dict.fromkeys(label for label, _, _ in rows))


def _tick_rotation(labels: list[str]) -> int:
    widest = max((len(str(l)) for l in labels), default=0)
    if widest <= 4 and len(labels) <= 14:
        return 0
    return 45 if widest <= 12 else 60


def draw(rows: list[tuple[str, str, float]], chart_type: str,
         fields: dict) -> tuple:
    """Build the figure. Returns (fig, ax, legend_or_None).

    Nothing here reads a value except to place it on an axis.
    """
    fig, ax = plt.subplots(figsize=(FIG_WIDTH_IN, FIG_HEIGHT_IN), dpi=DPI)
    labels = _label_order(rows)
    series = _series_order(rows)
    multi = len([s for s in series if s]) > 1 or (len(series) > 1)
    lookup = {(label, s): value for label, s, value in rows}

    legend = None
    if chart_type == "bar":
        ax.bar(range(len(labels)), [lookup.get((l, series[0]), 0.0) for l in labels],
               color=PALETTE[0], width=0.72)
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, rotation=_tick_rotation(labels),
                           ha="right" if _tick_rotation(labels) else "center")
        ax.grid(**GRID_KW)
    elif chart_type == "barh":
        order = list(reversed(labels))  # first CSV row at the top of the chart
        ax.barh(range(len(order)), [lookup.get((l, series[0]), 0.0) for l in order],
                color=PALETTE[0], height=0.7)
        ax.set_yticks(range(len(order)))
        ax.set_yticklabels(order)
        ax.grid(axis="x", linestyle=":", linewidth=0.6, alpha=0.6)
    elif chart_type == "line":
        for i, name in enumerate(series):
            ys = [lookup.get((l, name), 0.0) for l in labels]
            ax.plot(range(len(labels)), ys, marker="o", markersize=4,
                    linewidth=1.8, color=PALETTE[i % len(PALETTE)],
                    label=name or None)
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, rotation=_tick_rotation(labels),
                           ha="right" if _tick_rotation(labels) else "center")
        ax.grid(**GRID_KW)
    elif chart_type == "grouped_bar":
        n = max(len(series), 1)
        width = min(0.8 / n, 0.38)
        for i, name in enumerate(series):
            offsets = [x + (i - (n - 1) / 2) * width for x in range(len(labels))]
            ax.bar(offsets, [lookup.get((l, name), 0.0) for l in labels],
                   width=width, color=PALETTE[i % len(PALETTE)], label=name or None)
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, rotation=_tick_rotation(labels),
                           ha="right" if _tick_rotation(labels) else "center")
        ax.grid(**GRID_KW)
    else:  # pragma: no cover — guarded by the CLI
        raise BadInput(f"unknown chart type {chart_type!r}")

    # Counts are whole numbers, so "12.5 papers" on a tick is nonsense. This is
    # a tick-formatting choice, not a transformation: the plotted values are
    # untouched, only the label text on the value axis changes.
    if all(float(v).is_integer() for _, _, v in rows if not (math.isnan(v) or math.isinf(v))):
        value_axis = ax.xaxis if chart_type == "barh" else ax.yaxis
        value_axis.set_major_locator(MaxNLocator(integer=True))

    ax.set_xlabel(fields.get("x_label", ""))
    ax.set_ylabel(fields.get("y_label", ""))
    if fields.get("title"):
        ax.set_title(fields["title"])
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.set_axisbelow(True)

    if multi and any(series):
        # Fixed placement: above the axes, outside the data area. A legend
        # inside the axes is the usual way a generated chart ends up covering
        # its own tallest bar, and "loc='best'" only avoids that by accident.
        forced = os.environ.get("SLR_CHART_FORCE_LEGEND_LOC")
        if forced:
            legend = ax.legend(loc=forced, frameon=True)
        else:
            legend = ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.01),
                               ncol=min(len(series), 4), frameon=False,
                               fontsize="small", borderaxespad=0.0)
    fig.tight_layout()
    return fig, ax, legend


# ============================================================================
# QC — the gate between "drawn" and "written"
# ============================================================================


def _data_artists(ax):
    artists = []
    for container in ax.containers:
        artists.extend(list(container))
    artists.extend(ax.lines)
    return artists


def _rendered_point_count(ax, chart_type: str) -> int:
    if chart_type == "line":
        return sum(len(line.get_xdata()) for line in ax.lines)
    return sum(len(container) for container in ax.containers)


def _overlap_fraction(a, b) -> float:
    dx = min(a.x1, b.x1) - max(a.x0, b.x0)
    dy = min(a.y1, b.y1) - max(a.y0, b.y0)
    if dx <= 0 or dy <= 0:
        return 0.0
    area = max((a.x1 - a.x0) * (a.y1 - a.y0), 1e-9)
    return (dx * dy) / area


def run_qc(fig, ax, legend, rows, chart_type: str, fields: dict) -> list[str]:
    """Return the list of failed assertions (empty == the figure may be written)."""
    failures: list[str] = []

    if not rows:
        failures.append("no_data_points: the csv has zero data rows")
        return failures

    bad = [f"row{i + 1}={value}" for i, (_, _, value) in enumerate(rows)
           if math.isnan(value) or math.isinf(value)]
    if bad:
        failures.append(f"non_finite_value: {', '.join(bad[:5])}")

    for name, key in (("x", "x_label"), ("y", "y_label")):
        if not (fields.get(key) or "").strip():
            failures.append(f"missing_axis_label: {name}-axis label is empty")

    # Draw before measuring: extents are meaningless until the canvas has run.
    fig.canvas.draw()

    rendered = _rendered_point_count(ax, chart_type)
    if rendered != len(rows):
        failures.append(
            f"series_length_mismatch: drew {rendered} point(s) from {len(rows)} csv row(s)"
        )

    if legend is not None:
        renderer = fig.canvas.get_renderer()
        legend_box = legend.get_window_extent(renderer)
        worst = 0.0
        for artist in _data_artists(ax):
            try:
                box = artist.get_window_extent(renderer)
            except Exception:  # noqa: BLE001 — an artist without extents cannot overlap
                continue
            worst = max(worst, _overlap_fraction(legend_box, box))
        # 1% of the legend's own area is below the width of its border; anything
        # above that is the legend genuinely sitting on top of the data.
        if worst > 0.01:
            failures.append(
                f"legend_overlaps_data: legend covers plotted data "
                f"({worst * 100:.0f}% of the legend box)"
            )

    return failures


# ============================================================================
# Driver
# ============================================================================


def _remove_stale(*paths: Path) -> list[str]:
    removed = []
    for path in paths:
        if path and path.exists():
            try:
                path.unlink()
                removed.append(str(path))
            except OSError:
                pass
    return removed


def render(csv_path: Path, out_path: Path, chart_type: str, *,
           x_label: str, y_label: str, title: str = "",
           vector_path: Path | None = None, language: str = "english",
           x_label_fallback: str = "", y_label_fallback: str = "",
           title_fallback: str = "") -> dict:
    """Render one chart. Raises BadInput or QCFailure; returns the meta record."""
    if chart_type not in CHART_TYPES:
        raise BadInput(f"unknown chart type {chart_type!r}; supported: {', '.join(CHART_TYPES)}")
    if out_path.suffix.lower() != ".png":
        raise BadInput(f"--out must be a .png path, got {out_path.name}")
    if vector_path is None:
        vector_path = out_path.with_suffix(".pdf")
    if vector_path.suffix.lower() not in VECTOR_SUFFIXES:
        raise BadInput(
            f"--vector must end in {' or '.join(VECTOR_SUFFIXES)}, got {vector_path.name}"
        )

    rows = read_rows(csv_path)
    fields = {"x_label": x_label, "y_label": y_label, "title": title}
    fallbacks = {"x_label": x_label_fallback, "y_label": y_label_fallback,
                 "title": title_fallback}

    needs_cjk = any(_has_cjk(v) for v in fields.values()) or \
        any(_has_cjk(l) or _has_cjk(s) for l, s, _ in rows) or \
        language.strip().lower() == "chinese"

    font = {"family": None, "path": None, "reason": "not needed (no CJK text)",
            "rescanned": False, "candidates": []}
    fallback_report = None
    if needs_cjk:
        font = resolve_cjk_font()
        if not font["family"]:
            fields, rows, fallback_report = apply_cjk_fallback(fields, rows, fallbacks)
    apply_font(font)

    fig, ax, legend = draw(rows, chart_type, fields)
    try:
        failures = run_qc(fig, ax, legend, rows, chart_type, fields)
        if failures:
            # Nothing has been written yet, and anything left over from an
            # earlier run must go: a stale PNG next to a failed render is
            # indistinguishable from a fresh one to every downstream consumer.
            removed = _remove_stale(out_path, vector_path)
            raise QCFailure(failures + ([f"removed_stale_output: {', '.join(removed)}"]
                                        if removed else []))
        out_path.parent.mkdir(parents=True, exist_ok=True)
        vector_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fig.savefig(out_path, dpi=DPI, bbox_inches="tight",
                        facecolor="white", edgecolor="none")
            fig.savefig(vector_path, bbox_inches="tight",
                        facecolor="white", edgecolor="none")
        except OSError as exc:
            raise BadInput(f"could not write output: {exc}") from exc
    finally:
        plt.close(fig)

    meta = {
        "rendered_by": "scripts/generation/figures/_fast/render_chart.py",
        "csv": str(csv_path),
        "png": str(out_path),
        "vector": str(vector_path),
        "chart_type": chart_type,
        "rows": len(rows),
        "series": [s for s in _series_order(rows) if s],
        "x_label": fields["x_label"],
        "y_label": fields["y_label"],
        "title": fields["title"],
        "language": language,
        "dpi": DPI,
        "qc": "passed",
        "cjk": {
            "text_needs_cjk": needs_cjk,
            "font_family": font["family"],
            "font_path": font["path"],
            "font_cache_rescanned": font["rescanned"],
            "resolution": font["reason"],
            "fallback_to_ascii_labels": fallback_report is not None,
            **({"fallback_detail": fallback_report} if fallback_report else {}),
        },
    }
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Draw one chart from a CSV. The renderer never computes; "
                    "see compute_chart_data.py.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--csv", help="tidy CSV: label,series,value")
    ap.add_argument("--out", help="output PNG path")
    ap.add_argument("--vector", help="output PDF/PGF path (default: --out with .pdf)")
    ap.add_argument("--chart-type", default="bar", choices=CHART_TYPES)
    ap.add_argument("--x-label", default="", help="x axis label (survey language)")
    ap.add_argument("--y-label", default="", help="y axis label (survey language)")
    ap.add_argument("--title", default="", help="optional chart title")
    ap.add_argument("--x-label-fallback", default="", help="ASCII x label for the no-CJK-font path")
    ap.add_argument("--y-label-fallback", default="", help="ASCII y label for the no-CJK-font path")
    ap.add_argument("--title-fallback", default="", help="ASCII title for the no-CJK-font path")
    ap.add_argument("--language", default="english", help="survey language: english | chinese")
    ap.add_argument("--meta-out", help="write the render record here as JSON")
    ap.add_argument("--list-chart-types", action="store_true",
                    help="print the supported chart types as JSON and exit")
    args = ap.parse_args()

    if args.list_chart_types:
        print(json.dumps({"chart_types": list(CHART_TYPES)}))
        return EXIT_OK
    if not args.csv or not args.out:
        print("[FAIL] --csv and --out are required", file=sys.stderr)
        return EXIT_BAD_INPUT

    try:
        meta = render(
            Path(args.csv), Path(args.out), args.chart_type,
            x_label=args.x_label, y_label=args.y_label, title=args.title,
            vector_path=Path(args.vector) if args.vector else None,
            language=args.language,
            x_label_fallback=args.x_label_fallback,
            y_label_fallback=args.y_label_fallback,
            title_fallback=args.title_fallback,
        )
    except BadInput as exc:
        print(f"[FAIL] bad input: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except QCFailure as exc:
        print("[QC-FAIL] figure NOT written — the following assertions failed:",
              file=sys.stderr)
        for check in exc.checks:
            print(f"    - {check}", file=sys.stderr)
        return EXIT_QC_FAILURE

    if args.meta_out:
        Path(args.meta_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.meta_out).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "OK", **meta}, ensure_ascii=False, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
