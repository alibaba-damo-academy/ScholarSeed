#!/usr/bin/env scholarseed-skill-python
"""
validate_figures_meta.py — the figure-metadata contract, as a command.

Why this exists
---------------
The figure stage is done by a subagent (`references/roles/slr-figure-planner.md`), which
submits `_render_mode` / `_prompt` / `_caption` / `_latex_body` through
`figures plan --request`; the CLI validates before updating figures_worklist.json. Without a checkable contract the first sign of a bad
`_latex_body` is a xelatex crash forty minutes later.

This script is that contract as a command. It walks every item in the worklist
and applies `_shape_errors` to it, so the agent can check its own work before
the compile does.

Where the rules live
--------------------
Here, and only here. `_shape_errors` / `_VALID_MODES` used to be imported from
the script-side runner `run_figures_meta.py`, so that the two paths could not
drift; that runner has been deleted along with the rest of the all-script
fallback, so this module is now the single implementation. The error strings are
worded as repair instructions because the figure-planner agent reads them
directly and fixes its own output from them.

What it checks
--------------
    * all four keys present: _render_mode, _prompt, _latex_body, _caption
    * _render_mode is one of ('image', 'forest_taxonomy', 'data_chart')
    * _caption is a non-empty string
    * mode == 'data_chart':
        - _chart_spec present, a JSON object
        - _chart_spec.statistic names a statistic
          `figures/_fast/compute_chart_data.py` actually implements. The list is
          IMPORTED from that module (`SUPPORTED_STATISTICS`), never copied — a
          copy would let the validator bless a statistic the compute step has
          never heard of, and the failure would surface at render time.
        - _chart_spec.chart_type is one of `render_chart.CHART_TYPES`, imported
          the same way.
        - x_label / y_label non-empty (the renderer's QC rejects an empty axis
          label, so catching it here saves a render round-trip)
        - **no inline data.** Every _chart_spec value must be a string except
          `top_n`. A list, an object or a bare number in the spec means the
          agent tried to supply the numbers itself, which is the one thing the
          whole compute/render split exists to prevent.
        - _prompt and _latex_body must be null/empty
    * mode == 'image':
        - _prompt must be non-empty; no arbitrary word quota.
        - _latex_body must be null/empty
    * mode == 'forest_taxonomy':
        - _latex_body must contain \\begin{forest} ... \\end{forest}
        - forest body may use \\citep{} only (no \\cite / \\citet)
        - every cite_key inside the forest must come from the item's
          related_papers
        - _prompt must be null/empty

Usage
-----
    scholarseed-skill-python scripts/validate_figures_meta.py <workspace> [--json]

Exit status: 0 when every figure satisfies the contract, 1 when any does not,
2 when the worklist is missing or unreadable.
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
import slr_paths as _slr_paths  # noqa: E402
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402


# ============================================================================
# Shape validation — the figure-metadata contract.
#
# `references/roles/slr-figure-planner.md` states these rules in prose for the model;
# this is the executable version the agent runs against its own output.
# ============================================================================

_REQUIRED_KEYS = ("_render_mode", "_prompt", "_latex_body", "_caption")
_VALID_MODES = ("image", "forest_taxonomy", "data_chart")

# Canvas shapes an `image` figure may be generated at. Mirrors `SIZE_PRESETS`
# in `scripts/generation/figures/_fast/generate_images.py`, which holds the
# pixel dimensions and is the only place they belong — every one of them was
# verified against the live endpoint before being offered. Optional: absent
# means `wide`.
_VALID_IMAGE_SIZES = frozenset({"wide", "square", "tall"})

# A caption that opens by writing its own label. `\caption` already prints
# "图 1." / "Figure 1." (the preamble sets `\captionsetup{labelsep=period}`),
# so "图1：模型分类" renders as "图 1. 图1：模型分类". The duplicate is invisible
# to everything downstream — it is valid LaTeX, and the PDF text layer flattens
# it into one string — which is why the table-side version of this shipped in a
# finished survey. Mirrors `table_checks._CAPTION_SELF_LABEL_RE`.
_CAPTION_SELF_LABEL_RE = re.compile(
    r"^\s*(?:图|表|Figure|Fig|Table|Tab)\s*\.?\s*\d+\s*[.:：、．]", re.I)

# `data_chart` spec keys. Only `statistic` / `chart_type` / `x_label` / `y_label`
# are required; the rest are optional presentation hints.
_CHART_SPEC_REQUIRED = ("statistic", "chart_type", "x_label", "y_label")
_CHART_SPEC_OPTIONAL = ("title", "x_label_fallback", "y_label_fallback",
                        "title_fallback", "top_n", "rationale")
# The only spec key that may hold a number. Everything else is text; see
# `_chart_spec_errors` for why that matters.
_CHART_SPEC_NUMERIC = ("top_n",)
# Key names that betray an attempt to inline the data. Listed explicitly so the
# error the agent reads names its own mistake rather than a type violation.
_CHART_SPEC_DATA_KEYS = (
    "data", "values", "value", "rows", "series", "counts", "points",
    "labels", "x", "y", "x_values", "y_values", "dataset", "table", "numbers",
)


def _import_from_figures(module_name: str, attr: str):
    """Import an attribute from the figures pipeline, or return None.

    The compute/render pair is the source of truth for which statistics and
    chart types exist. Importing it here — rather than restating the lists —
    is what keeps this validator from accepting a `data_chart` the compute step
    cannot produce. When the import fails (a partial checkout, a broken
    matplotlib) the caller degrades to a shape-only check and says so, instead
    of silently validating against nothing.
    """
    figures_fast = Path(__file__).resolve().parent / "generation" / "figures" / "_fast"
    if str(figures_fast) not in sys.path:
        sys.path.insert(0, str(figures_fast))
    try:
        module = __import__(module_name)
        return getattr(module, attr)
    except Exception:  # noqa: BLE001 — any import failure degrades the same way
        return None


def supported_statistics() -> tuple[str, ...] | None:
    return _import_from_figures("compute_chart_data", "SUPPORTED_STATISTICS")


def supported_chart_types() -> tuple[str, ...] | None:
    return _import_from_figures("render_chart", "CHART_TYPES")


def _chart_spec_errors(payload: dict) -> list[str]:
    """Validate `_chart_spec` for a `data_chart` figure."""
    errors: list[str] = []
    spec = payload.get("_chart_spec")
    if spec is None:
        return ["_chart_spec is required when _render_mode == 'data_chart' "
                "(name a statistic and a chart type; do NOT supply numbers)"]
    if not isinstance(spec, dict):
        return [f"_chart_spec must be a JSON object, got {type(spec).__name__}"]

    for key in _CHART_SPEC_REQUIRED:
        value = spec.get(key)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"_chart_spec.{key} must be a non-empty string")

    # --- the no-inline-data rule -------------------------------------------
    # A data_chart's numbers come from compute_chart_data.py reading the corpus.
    # Anything numeric or structured in the spec is the agent supplying values
    # it made up, which is exactly the unverifiable-figure failure the split
    # exists to prevent — so it is an error, not a warning.
    for key, value in spec.items():
        if key.lower() in _CHART_SPEC_DATA_KEYS and key not in _CHART_SPEC_REQUIRED:
            errors.append(
                f"_chart_spec.{key} is inline data — a data_chart may not carry "
                f"numbers; the figure's values are computed from the corpus by "
                f"compute_chart_data.py. Name a statistic instead."
            )
            continue
        if key in _CHART_SPEC_NUMERIC:
            if not isinstance(value, (int, str)) or isinstance(value, bool):
                errors.append(f"_chart_spec.{key} must be an integer or a numeric string")
            continue
        if isinstance(value, (list, dict)):
            errors.append(
                f"_chart_spec.{key} is a {type(value).__name__} — _chart_spec "
                f"carries only text; inline data is forbidden"
            )
        elif isinstance(value, bool) or isinstance(value, (int, float)):
            errors.append(
                f"_chart_spec.{key} is a number — the only numbers in a "
                f"data_chart come from the corpus, never from the figure plan"
            )
        elif not isinstance(value, str):
            errors.append(f"_chart_spec.{key} must be a string")

    unknown = [k for k in spec
               if k not in _CHART_SPEC_REQUIRED and k not in _CHART_SPEC_OPTIONAL
               and k.lower() not in _CHART_SPEC_DATA_KEYS]
    if unknown:
        errors.append(
            f"_chart_spec has unknown key(s) {sorted(unknown)}; allowed: "
            f"{sorted(_CHART_SPEC_REQUIRED + _CHART_SPEC_OPTIONAL)}"
        )

    # --- names must exist in the real implementations ----------------------
    statistic = spec.get("statistic")
    known_stats = supported_statistics()
    if isinstance(statistic, str) and statistic.strip():
        if known_stats is None:
            errors.append(
                "could not import compute_chart_data.SUPPORTED_STATISTICS — the "
                "statistic name could not be checked against the real list"
            )
        elif statistic.strip() not in known_stats:
            errors.append(
                f"_chart_spec.statistic {statistic!r} is not computed by "
                f"compute_chart_data.py; supported: {', '.join(known_stats)}"
            )

    chart_type = spec.get("chart_type")
    known_types = supported_chart_types()
    if isinstance(chart_type, str) and chart_type.strip():
        if known_types is None:
            errors.append(
                "could not import render_chart.CHART_TYPES — the chart type "
                "could not be checked against the real list"
            )
        elif chart_type.strip() not in known_types:
            errors.append(
                f"_chart_spec.chart_type {chart_type!r} is not supported by "
                f"render_chart.py; supported: {', '.join(known_types)}"
            )

    return errors


def _shape_errors(payload: Any, item: dict) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["response is not a JSON object"]
    for k in _REQUIRED_KEYS:
        if k not in payload:
            errors.append(f"missing required key: {k}")
    if errors:
        return errors

    mode = payload.get("_render_mode")
    if mode not in _VALID_MODES:
        errors.append(f"_render_mode must be one of {_VALID_MODES}, got {mode!r}")

    from figure_caption import caption_errors
    errors.extend(caption_errors(payload.get('_caption'),item))

    if mode == "image":
        prompt = payload.get("_prompt") or ""
        if not isinstance(prompt, str) or not prompt.strip():
            errors.append("_prompt must be non-empty when _render_mode == 'image'")
        if payload.get("_latex_body") not in (None, "", []):
            errors.append("_latex_body must be null when _render_mode == 'image'")
        # Optional: the canvas shape. Absent means `wide`, which suits most
        # figures. A value outside the preset list is caught here rather than
        # in `generate_images.py`, which falls back to `wide` and carries on —
        # by design, since dropping a figure over a misspelt preset would be a
        # worse outcome than drawing it in the wrong shape, but a silent
        # fallback is still a planner mistake worth naming while it is cheap.
        size = payload.get("_image_size")
        if size not in (None, "") and size not in _VALID_IMAGE_SIZES:
            errors.append(
                f"_image_size must be one of {sorted(_VALID_IMAGE_SIZES)} or "
                f"null, got {size!r}. `wide` (16:9) suits flows and pipelines, "
                f"`tall` (9:16) hierarchies that read downward, `square` "
                f"balanced or radial layouts."
            )
    elif mode == "data_chart":
        errors.extend(_chart_spec_errors(payload))
        if payload.get("_prompt") not in (None, "", []):
            errors.append("_prompt must be null when _render_mode == 'data_chart' "
                          "(no image model is involved; the chart is computed and drawn)")
        if payload.get("_latex_body") not in (None, "", []):
            errors.append("_latex_body must be null when _render_mode == 'data_chart' "
                          "(write_latex.py emits the \\includegraphics wrapper)")
    elif mode == "forest_taxonomy":
        # A forest tree used to be forbidden outright under `scope: speed`, on
        # the grounds that it crowds a short survey. It cost more than it saved:
        # `speed` is the default, so the ban fired on almost every run, and a
        # planner that wanted to draw a taxonomy fell back to a bar chart of
        # publication years — a worse figure, chosen by a rule rather than by
        # judgement. Whether a tree earns its space on a twelve-page survey is
        # the planner's call now.
        body = payload.get("_latex_body") or ""
        if not isinstance(body, str) or "\\begin{forest}" not in body or "\\end{forest}" not in body:
            errors.append("_latex_body must contain a \\begin{forest}…\\end{forest} block")
        if "\\cite{" in (body or "") or re.search(r"\\citet\{", body or ""):
            errors.append("forest body must use \\citep{} only (no \\cite or \\citet)")
        # Check cite_keys referenced inside the forest are subset of related_papers
        allowed = {(p.get("cite_key") or "").strip()
                   for p in (item.get("related_papers") or [])
                   if (p.get("cite_key") or "").strip()}
        used: set[str] = set()
        for m in re.findall(r"\\citep\{([^}]+)\}", body or ""):
            for k in m.split(","):
                k = k.strip()
                if k:
                    used.add(k)
        bogus = used - allowed
        if bogus:
            errors.append(f"forest cites unknown cite_keys: {sorted(bogus)[:5]}")
        if payload.get("_prompt") not in (None, "", []):
            errors.append("_prompt must be null when _render_mode == 'forest_taxonomy'")

    return errors


def _load_worklist(workspace: Path) -> tuple[dict | None, str | None]:
    """Read `figures_worklist.json`; return (payload, error_message)."""
    path = workspace / "05_generation" / "_internal" / "figures_worklist.json"
    if not path.is_file():
        return None, f"figures_worklist.json not found at {path}"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"figures_worklist.json is not readable JSON: {exc}"
    if not isinstance(data, dict):
        return None, "figures_worklist.json is not a JSON object"
    return data, None


def validate(worklist: dict) -> tuple[list[dict], dict, list[str]]:
    """Apply `_shape_errors` to every item.

    Returns (per_figure_results, stats, warnings). A result is
    `{"figure_id": str, "errors": [str]}`; an empty error list means that
    figure passes.
    """
    items = worklist.get("items")
    if items is None:
        items = []
    if not isinstance(items, list):
        return (
            [{"figure_id": "?", "errors": ["worklist 'items' is not a list"]}],
            {"total": 0},
            [],
        )

    results: list[dict] = []
    warnings: list[str] = []
    by_mode: dict[str, int] = {}

    for idx, item in enumerate(items):
        fid = str((item or {}).get("figure_id") or f"#{idx}") if isinstance(item, dict) else f"#{idx}"
        if not isinstance(item, dict):
            results.append({"figure_id": fid, "errors": ["worklist item is not a JSON object"]})
            continue

        # `_shape_errors(payload, item)` reads the four agent-written keys off
        # `payload` and the *context* keys (language, scope, related_papers) off
        # `item`. Once the stage has run, both live on the same worklist entry,
        # so the entry serves as both arguments. Key *presence* matters (the
        # missing-key branch tests `k not in payload`), which is why the item is
        # passed as-is rather than reconstructed with `.get()` defaults.
        errors = _shape_errors(item, item)
        results.append({"figure_id": fid, "errors": errors})

        mode = item.get("_render_mode")
        if isinstance(mode, str):
            by_mode[mode] = by_mode.get(mode, 0) + 1

        # `_shape_errors` reads scope/language from the item only.
        # `collect_figures.py` mirrors the top-level values
        # onto every item, so a missing one means a hand-edited worklist and the
        # CJK prompt-length rule would silently take its default.
        # Warn rather than substitute: substituting would change the verdict.
        for field in ("scope", "language"):
            if not item.get(field) and worklist.get(field):
                warnings.append(
                    f"figure {fid} has no item-level '{field}'; the contract reads it "
                    f"from the item, not from the worklist's top-level "
                    f"'{field}': {worklist[field]!r} — restore it on the item"
                )

    failed = [r for r in results if r["errors"]]
    stats = {
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "by_render_mode": by_mode,
        "failed_figure_ids": [r["figure_id"] for r in failed],
        "scope": worklist.get("scope"),
        "language": worklist.get("language"),
        "valid_render_modes": list(_VALID_MODES),
        # Echoed from the compute/render modules themselves so the agent reading
        # this report sees the same list the validator checked against.
        "supported_statistics": list(supported_statistics() or []),
        "supported_chart_types": list(supported_chart_types() or []),
    }
    return results, stats, warnings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("workspace", nargs="?", default=".", help="run workspace (default: cwd)")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = ap.parse_args()

    workspace = Path(args.workspace).resolve()
    worklist, load_error = _load_worklist(workspace)
    if worklist is None:
        print(f"[FAIL] {load_error}", file=sys.stderr)
        return 2

    results, stats, warnings = validate(worklist)

    # Flat, self-describing strings so the caller never has to join the figure
    # id back onto its error to know what to fix.
    errors = [
        f"{r['figure_id']}: {err}"
        for r in results
        for err in r["errors"]
    ]

    report = {
        "valid": not errors,
        "errors": errors,
        "stats": stats,
        "worklist": str(workspace / "05_generation" / "_internal" / "figures_worklist.json"),
    }
    if warnings:
        report["warnings"] = warnings

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if errors else 0

    for warn in warnings:
        print(f"[WARN] {warn}")
    if errors:
        failed = [r for r in results if r["errors"]]
        print(f"[FAIL] {len(failed)} of {stats['total']} figure(s) violate the metadata contract:")
        for r in failed:
            print(f"  {r['figure_id']}:")
            for err in r["errors"]:
                print(f"    - {err}")
    elif stats["total"] == 0:
        # An empty worklist is a legitimate SUCCESS ("No figures requested.");
        # say so explicitly so a silent [OK] is not mistaken for
        # "the figures were checked".
        print("[OK] no figures requested — nothing to validate.")
    else:
        modes = ", ".join(f"{k}={v}" for k, v in sorted(stats["by_render_mode"].items()))
        print(f"[OK] {stats['total']} figure(s) satisfy the metadata contract: {modes or 'no modes set'}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
