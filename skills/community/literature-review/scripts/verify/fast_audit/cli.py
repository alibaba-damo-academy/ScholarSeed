#!/usr/bin/env scholarseed-skill-python
"""Compatibility direct audit CLI. Not the current slr run verify_audit entry.

Optional Chinese tokenization needs scripts/compatibility/requirements.txt.
Current publication uses manuscript_publication's four rules."""

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
import sys
import time
from pathlib import Path

# jieba is imported lazily by pkg/_utils.py on the first Chinese-tokenization
# path; English-only workspaces skip the cost entirely. The previous eager
# preload here added ~0.5–1.5 s to every run regardless of draft language;
# pkg/_utils.tokenize() surfaces an actionable RuntimeError if the dependency
# is missing when zh is actually needed.

_HERE = Path(__file__).resolve().parent
_INTERNAL = _HERE / "_internal"  # [slr] cli.py now sits beside _internal/
if str(_INTERNAL) not in sys.path:
    sys.path.insert(0, str(_INTERNAL))

from pkg import (                                                    # noqa: E402
    aggregator as m_agg,
    bibtex_local as m_bib,
    citation_reality as m_cr,
    content_quality as m_cq,
    coverage as m_cov,
    crossfield as m_cf,
    integrity as m_int,
    latex_safety as m_ls,
    merger as m_merge,
    placeholder as m_ph,
    relevance as m_rel,
    splitter,
)
import prepare_inputs                                                # noqa: E402
from workspace_io import StatusCode, WorkspaceIO                     # noqa: E402

VERSION = "1.0.0-online"

EXIT_PASS = 0
EXIT_PARTIAL = 1
EXIT_REJECT = 2
EXIT_INPUT = 3
EXIT_TOOL = 4


# ── per-module runners ────────────────────────────────────────────────────
def _run_placeholder(io: WorkspaceIO) -> dict:
    # Use the include-expanded draft so cite-keys inside \input{tables/T*.tex}
    # / figure subfiles are scanned (otherwise placeholder/hallucinated keys
    # buried in table subfiles are silently missed).
    text = io.read_full_draft()
    parsed = splitter.parse_text(text)
    cite_keys: list[str] = []
    for c in parsed["citations"]:
        meta = c.get("metadata", {})
        if meta.get("cite_keys"):
            cite_keys.extend(meta["cite_keys"])
        elif meta.get("cite_key"):
            cite_keys.append(meta["cite_key"])
        else:
            cite_keys.append(c.get("raw", ""))
    result = m_ph.check_batch(cite_keys, raw_citation=text[:5000])
    io.write_json("tmp", "citation_placeholder.json", result)
    status = (StatusCode.SUCCESS if result["placeholder_count"] == 0
              else StatusCode.PARTIAL_SUCCESS)
    io.write_status("placeholder", status,
                    output_file="tmp/citation_placeholder.json",
                    stats={"placeholder_count": result["placeholder_count"],
                           "total": result["total"]})
    return {"status": status.value, **result}


def _run_content_quality(io: WorkspaceIO) -> dict:
    text = io.read_draft()
    result = m_cq.check_strict_quality(text)
    io.write_json("output", "content_quality_result.json", result)
    status = StatusCode.SUCCESS if result["passed"] else StatusCode.PARTIAL_SUCCESS
    io.write_status("content_quality", status,
                    output_file="output/content_quality_result.json",
                    stats={"template_ratio": result["template_ratio"],
                           "critical_matches": result["critical_matches"]})
    return {"status": status.value, **result}


def _run_latex_safety(io: WorkspaceIO) -> dict:
    """S-tier LaTeX compile-safety check: image placeholder fallback text,
    references to figures whose generation upstream marked as failed, and
    unescaped `%` in prose that would silently truncate lines in the PDF."""
    result = m_ls.audit(io.workspace)
    io.write_json("output", "latex_safety_result.json", result)
    status = StatusCode.SUCCESS if result["passed"] else StatusCode.REJECTED
    io.write_status("latex_safety", status,
                    output_file="output/latex_safety_result.json",
                    stats={
                        "passed": result["passed"],
                        "image_placeholder_count": result["image_placeholder_count"],
                        "unescaped_percent_count": result["unescaped_percent_count"],
                        "failed_figures_referenced":
                            result["failed_figures_referenced"],
                        "table_overflow_count":
                            result.get("table_overflow_count", 0),
                    })
    return {"status": status.value, **result}


def _run_integrity(io: WorkspaceIO) -> dict:
    experiment_data = io.read_subinput("experiment_data")
    if experiment_data is None:
        # In a literature-review workspace, integrity has no faithful
        # source-of-truth (the draft cites others' experiment numbers,
        # not its own). Surface a self-explaining N/A rather than the
        # generic "missing file" reason, so the operator does not chase
        # a non-existent file.
        if prepare_inputs.is_survey_workspace(io.workspace):
            reason = ("N/A: integrity not applicable in survey scope "
                      "(no original experiment data)")
        else:
            reason = "input/experiment_data.json missing"
        io.write_status("integrity", StatusCode.SKIPPED, reason=reason)
        return {"status": StatusCode.SKIPPED.value, "reason": reason}
    text = io.read_draft()
    result = m_int.run_integrity(text, experiment_data)
    io.write_json("output", "integrity_result.json", result)
    severity = result.get("severity", "PASS")
    status = {
        "PASS": StatusCode.SUCCESS,
        "WARN": StatusCode.PARTIAL_SUCCESS,
        "REJECT": StatusCode.REJECTED,
    }.get(severity, StatusCode.FAILED)
    io.write_status("integrity", status,
                    output_file="output/integrity_result.json",
                    stats={"severity": severity,
                           "total": result.get("total_numbers"),
                           "verified": result.get("verified_numbers")})
    return {"status": status.value, **result}


def _run_crossfield(io: WorkspaceIO) -> dict:
    db_map = io.read_subinput("db_metadata")
    if not db_map:
        io.write_status("crossfield", StatusCode.SKIPPED,
                        reason="input/db_metadata.json missing or empty")
        return {"status": StatusCode.SKIPPED.value,
                "reason": "input/db_metadata.json missing or empty"}

    text = io.read_full_draft()
    parsed = splitter.parse_text(text)
    items = []
    for c in parsed["citations"]:
        meta = c.get("metadata", {})
        ref_num = meta.get("ref_number")
        keys: list[str] = []
        if ref_num is not None:
            keys.append(str(ref_num))
        if meta.get("cite_key"):
            keys.append(meta["cite_key"])
        keys.extend(meta.get("cite_keys", []) or [])
        for key in keys:
            db = db_map.get(key)
            if not db:
                continue
            claimed = {
                "title": meta.get("title", ""),
                "first_author": (meta.get("authors", "").split(",")[0].strip()
                                 if meta.get("authors") else ""),
                "year": meta.get("year"),
            }
            # If the citation site carries no inline claim (bare \cite{key}),
            # there is nothing to be inconsistent with — skip rather than
            # spuriously flag identifier_hijacking on empty-vs-DB comparison.
            if (not claimed["title"] and not claimed["first_author"]
                    and claimed["year"] is None):
                continue
            items.append({"citation_raw": c.get("raw", ""),
                          "claimed": claimed, "db_returned": db})
    result = m_cf.validate_batch(items)
    io.write_json("tmp", "citation_crossfield.json", result)
    status = (StatusCode.SUCCESS if result["inconsistent_count"] == 0
              else StatusCode.PARTIAL_SUCCESS)
    io.write_status("crossfield", status,
                    output_file="tmp/citation_crossfield.json",
                    stats={"total": result["total"],
                           "inconsistent": result["inconsistent_count"]})
    return {"status": status.value, **result}


def _run_coverage(io: WorkspaceIO) -> dict:
    payload = io.read_subinput("coverage_input")
    if not payload:
        io.write_status("coverage", StatusCode.SKIPPED,
                        reason="input/coverage_input.json missing")
        return {"status": StatusCode.SKIPPED.value,
                "reason": "input/coverage_input.json missing"}
    sections = payload.get("sections", [])
    papers = payload.get("retrieved_papers", payload.get("papers", []))
    result = m_cov.audit_coverage(sections, papers, payload.get("expected_topics"))
    io.write_json("output", "coverage_result.json", result)
    # f1 may be None when the (sections, papers) pair cannot share a TF-IDF
    # language bucket — surface SKIPPED instead of a spurious bad-score gate.
    f1 = result.get("coverage_f1")
    if f1 is None:
        status = StatusCode.SKIPPED
        reason = result.get("reason", "cross_lingual_skipped")
        io.write_status("coverage", status,
                        output_file="output/coverage_result.json",
                        reason=reason,
                        stats={"coverage_f1": None,
                               "cross_lingual_skipped": True})
    else:
        scored_papers = result.get("scored_papers") or 0
        if scored_papers and scored_papers < 3:
            status = StatusCode.SKIPPED
            io.write_status("coverage", status,
                            output_file="output/coverage_result.json",
                            reason=f"scored_papers={scored_papers} < 3",
                            stats={"coverage_f1": f1,
                                   "scored_lang_bucket": result.get("scored_lang_bucket"),
                                   "scored_papers": scored_papers})
        else:
            status = (StatusCode.SUCCESS if f1 >= 0.7
                      else StatusCode.PARTIAL_SUCCESS)
            io.write_status("coverage", status,
                            output_file="output/coverage_result.json",
                            stats={"coverage_f1": f1,
                                   "scored_lang_bucket": result.get("scored_lang_bucket"),
                                   "scored_papers": scored_papers})
    return {"status": status.value, **result}


def _run_relevance(io: WorkspaceIO) -> dict:
    items = io.read_subinput("relevance_pairs")
    if not items:
        reason = prepare_inputs.diagnose_relevance_pairs(io.workspace)
        io.write_status("relevance", StatusCode.SKIPPED, reason=reason)
        return {"status": StatusCode.SKIPPED.value, "reason": reason}
    result = m_rel.compute_batch(items)
    io.write_json("output", "relevance_result.json", result)
    # Effective denominator excludes cross-lingual pairs the relevance module
    # marked as `skipped` — they aren't evidence of irrelevance, they're
    # evidence that TF-IDF can't bridge languages. The 0.8 threshold matches
    # merger._eval_relevance in the compatibility audit.
    effective = result["total"] - result.get("skipped", 0)
    # Minimum sample size 5 — mirrors merger._eval_relevance to avoid a single
    # outlier pair flipping the module status.
    if effective >= 5 and result["failed"] > effective * 0.8:
        status = StatusCode.REJECTED
    elif result["failed"] > 0:
        status = StatusCode.PARTIAL_SUCCESS
    else:
        status = StatusCode.SUCCESS
    io.write_status("relevance", status,
                    output_file="output/relevance_result.json",
                    stats={"total": result["total"],
                           "failed": result["failed"],
                           "skipped": result.get("skipped", 0),
                           "effective": effective})
    return {"status": status.value, **result}


def _run_citation_reality(io: WorkspaceIO) -> dict:
    """S-tier offline citation-reality check (module #7).

    Inputs (all optional except draft + .bib):
        ./05_generation/full_draft.{tex,md,txt}     required
        ./05_generation/citations.bib               required (else SKIPPED)
        ./05_generation/_internal/cite_keys.json    optional
        ./03_process/paper_cards.json               optional
    """
    bib_text = io.read_bib()
    if bib_text is None:
        io.write_status("citation_reality_offline", StatusCode.SKIPPED,
                        reason="05_generation/citations.bib missing")
        return {"status": StatusCode.SKIPPED.value,
                "reason": "05_generation/citations.bib missing"}

    draft = io.read_full_draft()
    bib_map = m_bib.parse_bib(bib_text)
    cite_keys_map = io.read_cite_keys_map()
    paper_cards = io.read_paper_cards()

    result = m_cr.check_citation_reality(
        draft, bib_map, cite_keys_map, paper_cards,
    )
    io.write_json("output", "citation_reality_result.json", result)

    verdict = result["verdict"]
    if verdict == "PARTIAL_HALLUCINATED":
        status = StatusCode.REJECTED
    elif verdict in ("PARTIAL_SUSPICIOUS", "ALL_SKIPPED"):
        status = StatusCode.PARTIAL_SUCCESS
    else:
        status = StatusCode.SUCCESS
    io.write_status("citation_reality_offline", status,
                    output_file="output/citation_reality_result.json",
                    stats={"total": result["total"],
                           "verified": result["verified"],
                           "suspicious": result["suspicious"],
                           "hallucinated": result["hallucinated"],
                           "skipped": result["skipped"]})
    return {"status": status.value, **result}


MODULE_RUNNERS = {
    "placeholder":               _run_placeholder,
    "content_quality":           _run_content_quality,
    "latex_safety":              _run_latex_safety,
    "integrity":                 _run_integrity,
    "crossfield":                _run_crossfield,
    "coverage":                  _run_coverage,
    "relevance":                 _run_relevance,
    "citation_reality_offline":  _run_citation_reality,
}


# ── command handlers ──────────────────────────────────────────────────────
def cmd_init(io: WorkspaceIO) -> dict:
    io.ensure()
    return {
        "status": "SUCCESS",
        "verifier_root": str(io.verifier_root),
        "fast_audit_root": str(io.fa_root),
        "subdirs": ["input (shared at 07_verifier/input)",
                    "fast_audit/tmp", "fast_audit/output", "fast_audit/status"],
    }


def cmd_module(io: WorkspaceIO, name: str) -> dict:
    if name not in MODULE_RUNNERS:
        return {"status": "FAILED",
                "error": f"unknown module '{name}'",
                "valid": sorted(MODULE_RUNNERS)}
    io.ensure()
    return MODULE_RUNNERS[name](io)


def cmd_merge(io: WorkspaceIO) -> dict:
    io.ensure()
    report = m_merge.merge(io)
    io.write_json("output", "fast_audit_report.json", report)
    verdict = report["verdict"]
    status = {
        "PASS": StatusCode.SUCCESS,
        "PARTIAL_SUCCESS": StatusCode.PARTIAL_SUCCESS,
        "REJECTED": StatusCode.REJECTED,
        "TOOL_UNAVAILABLE": StatusCode.FAILED,
    }.get(verdict, StatusCode.FAILED)
    io.write_status("fast_audit", status,
                    output_file="output/fast_audit_report.json",
                    stats={"verdict": verdict,
                           "elapsed_ms": report["elapsed_ms"],
                           "modules_passed": report["modules_passed"],
                           "modules_failed": report["modules_failed"],
                           "modules_skipped": report["modules_skipped"]})
    return {"status": status.value, "report": report}


def cmd_aggregate(io: WorkspaceIO) -> dict:
    """Phase 2: Chinese aggregation. Reads existing per-module artefacts +
    fast_audit_report.json, writes aggregated_issues.json + final_report.md."""
    io.ensure()
    payload = m_agg.aggregate(io)
    return {
        "status": "SUCCESS",
        "verdict": payload.get("verdict"),
        "issue_count": len(payload.get("issues", [])),
        "aggregated_issues_path": str(io.output_dir / "aggregated_issues.json"),
        "final_report_path":      str(io.output_dir / "final_report.md"),
    }


def cmd_run(io: WorkspaceIO) -> dict:
    io.ensure()
    # Fail-fast: surface INPUT_MISSING via main()'s global FileNotFoundError
    # handler when neither 06_output/survey.tex nor 05_generation/full_draft.*
    # exists. Without this, the per-runner try/except below would swallow the
    # error and the merger would mis-aggregate to PASS over an empty workspace.
    io.read_draft()
    skip_files: tuple[str, ...] = ()
    if prepare_inputs.is_survey_workspace(io.workspace):
        skip_files = ("experiment_data.json",)
    prep = prepare_inputs.auto_prepare(io.workspace, skip_files=skip_files)
    dispatch_errors: dict[str, str] = {}
    for name in MODULE_RUNNERS:
        try:
            MODULE_RUNNERS[name](io)
        except FileNotFoundError as e:
            dispatch_errors[name] = f"FileNotFoundError: {e}"
        except Exception as e:                       # noqa: BLE001
            dispatch_errors[name] = repr(e)
    merged = cmd_merge(io)
    aggregated = cmd_aggregate(io)

    # Full payload (prepare_inputs detail, full report, aggregate detail,
    # dispatch errors) goes to disk so stdout stays terse.
    full_payload = {"prepare_inputs": prep, **merged, "aggregate": aggregated}
    if dispatch_errors:
        full_payload["dispatch_errors"] = dispatch_errors
    io.write_json("output", "run_summary.json", full_payload)

    report = merged.get("report") or {}
    summary = {
        "status": merged.get("status"),
        "verdict": report.get("verdict"),
        "elapsed_ms": report.get("elapsed_ms"),
        "modules": {
            "passed":  report.get("modules_passed"),
            "failed":  report.get("modules_failed"),
            "skipped": report.get("modules_skipped"),
        },
        "issue_count": aggregated.get("issue_count"),
        "outputs": {
            "run_summary":       str(io.output_dir / "run_summary.json"),
            "fast_audit_report": str(io.output_dir / "fast_audit_report.json"),
            "aggregated_issues": aggregated.get("aggregated_issues_path"),
            "final_report":      aggregated.get("final_report_path"),
        },
    }
    if dispatch_errors:
        summary["dispatch_errors"] = len(dispatch_errors)
    return summary


def cmd_info() -> dict:
    return {
        "status": "SUCCESS",
        "version": VERSION,
        "modules": [
            {"name": k, "tier": tier, "source": f"{sub}/{fname}"}
            for k, tier, sub, fname in m_merge.MODULES
        ],
        "exit_codes": {
            "PASS": EXIT_PASS, "PARTIAL_SUCCESS": EXIT_PARTIAL,
            "REJECTED": EXIT_REJECT, "INPUT_MISSING": EXIT_INPUT,
            "TOOL_UNAVAILABLE": EXIT_TOOL,
        },
        "subcommands": ["init", "module <name>", "merge", "aggregate",
                        "run", "info"],
    }


def _verdict_to_exit(payload: dict) -> int:
    verdict = (
        payload.get("verdict")
        or (payload.get("report") or {}).get("verdict")
        or payload.get("status")
    )
    if verdict in ("PASS", "SUCCESS"):
        return EXIT_PASS
    if verdict == "PARTIAL_SUCCESS":
        return EXIT_PARTIAL
    if verdict in ("REJECTED", "FAIL"):
        return EXIT_REJECT
    if verdict == "TOOL_UNAVAILABLE":
        return EXIT_TOOL
    if verdict in ("FAILED",):
        return EXIT_INPUT
    return EXIT_PASS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="fast-audit-cli",
        description="Fast-Audit isolated CLI (see ../SKILL.md for spec).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create ./07_verifier/ tree")

    p_mod = sub.add_parser("module", help="run a single module")
    p_mod.add_argument("name", choices=sorted(MODULE_RUNNERS))

    sub.add_parser("merge", help="aggregate existing artefacts")
    sub.add_parser("aggregate",
                   help="produce aggregated_issues.json + final_report.md")
    sub.add_parser("run", help="run all 8 modules + merge + aggregate")

    sub.add_parser("info", help="print module list + version")

    args = parser.parse_args(argv)

    # Wall-clock from CLI entry to exit. Distinct from each module's internal
    # elapsed_ms and from merger's aggregation elapsed_ms — this is the total
    # invocation cost the operator pays, including argparse + WorkspaceIO
    # setup + dispatch + JSON dump.
    cli_started = time.perf_counter()

    def _cli_elapsed_ms() -> float:
        return round((time.perf_counter() - cli_started) * 1000.0, 4)

    try:
        if args.cmd == "info":
            payload = cmd_info()
        else:
            io = WorkspaceIO()                       # workspace = Path.cwd()
            if args.cmd == "init":
                payload = cmd_init(io)
            elif args.cmd == "module":
                payload = cmd_module(io, args.name)
            elif args.cmd == "merge":
                payload = cmd_merge(io)
            elif args.cmd == "aggregate":
                payload = cmd_aggregate(io)
            elif args.cmd == "run":
                payload = cmd_run(io)
            else:
                payload = {"status": "FAILED", "error": f"unknown cmd {args.cmd}"}
    except FileNotFoundError as e:
        json.dump({"status": "INPUT_MISSING", "error": str(e),
                   "cli_elapsed_ms": _cli_elapsed_ms()},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        return EXIT_INPUT
    except Exception as e:                           # noqa: BLE001
        json.dump({"status": "TOOL_UNAVAILABLE", "error": repr(e),
                   "cli_elapsed_ms": _cli_elapsed_ms()},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        return EXIT_TOOL

    payload["cli_elapsed_ms"] = _cli_elapsed_ms()
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return _verdict_to_exit(payload)


if __name__ == "__main__":
    sys.exit(main())
