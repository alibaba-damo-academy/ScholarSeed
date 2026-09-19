"""Compatibility status aggregation for older section workflows.

Current manuscript_publication writes its own publication receipt without this
legacy quality/refinement aggregation."""
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

PROJECT_ROOT = Path(__file__).resolve().parents[4]
pass
from writing_contract import load_outline
from _utils import (  # noqa: E402
    Workspace,
    load_json,
    log_script_start,
    now_iso,
    write_json,
    write_status,
)

# Maps real on-disk status filenames to logical pipeline stages.
# Upstream skill scripts each write their own status file (e.g.
# validate_drafts.json). Generation-orchestrator scripts use phaseNN_xxx.json.
# Order here drives the order of `stage_timeline` entries in generation_report.json.
#
# Deterministic scripts appear here, plus the composite figure plan-generate
# status written by the figure subagent's relative CLI command. Other judgement
# steps reach this report through the collect/validate scripts that bracket them.
_PHASE_TO_STAGE = {
    "phase00_bootstrap":             "bootstrap",
    "collect_drafting_worklist":     "drafting_collect",
    "validate_drafts":               "drafting_validate",
    # Post 2026-05 refactor: refinement now operates at the document level
    # (agent reads full_draft_v1.tex and writes full_draft_v2.tex). The
    # legacy per-section refinement keys are retained for backwards
    # compatibility with status files written by older runs.
    "collect_refinement_worklist":   "refinement_collect",
    "run_refinement":                "refinement_run",
    "validate_refined":              "refinement_validate",
    "collect_table_specs":           "tables_collect",
    "validate_tables":               "tables_validate",
    "collect_figures":               "figures_collect",
    "figures_plan_generate":         "figures_plan_generate",
    "generate_images":               "figures_render",
    "write_latex":                   "figures_latex",
    "phase05_merge_full_draft":      "merge_v1",
    # There is no `phase05a_refine_full_draft` row: v1 -> v2 refinement is the
    # `legacy refiner` subagent, which writes the draft directly and no status
    # file. Its outcome reaches this report through phase05b's `source_kind`,
    # which says `v1_fallback` when v2 never appeared.
    "phase05b_insert_assets":        "insert_assets_v3",
    "phase06_quality_check":         "quality_check",
    "phase07_compile_latex":         "latex_compile",
}


def _load_status(ws: Workspace, phase: str) -> dict | None:
    p = ws.status_dir / f"{phase}.json"
    if not p.exists():
        return None
    return load_json(p)


def _deliverable(ws: Workspace, compile_st: dict) -> Path | None:
    """The file the user is being given, or None if there is not one yet.

    Phase 7's `output` is authoritative — it is the path phase 7 actually wrote
    — and is trusted whenever it still exists on disk. Everything else here is
    recovery for a workspace whose phase 7 status is missing or stale.
    """
    recorded = compile_st.get("output")
    if isinstance(recorded, str) and recorded:
        path = Path(recorded)
        if path.exists():
            return path
    for candidate in (ws.survey_pdf_path, ws.output / "survey.md",
                      ws.survey_md_fallback_path):
        if candidate.exists():
            return candidate
    return None


_OUTPUT_FORM = {
    ".pdf": "PDF",
    ".md": "Markdown",
}


def _final_status(stage_results: list[dict]) -> str:
    # SKIPPED is still tolerated for forward compatibility (some phases may
    # opt to skip themselves under future flags) but no current phase emits
    # it; it is treated as SUCCESS by the aggregator.
    if any(s.get("status") == "FAILED" for s in stage_results):
        return "FAILED"
    if any(
        s.get("status") in ("PARTIAL_SUCCESS", "PASS_WITH_WARNINGS")
        for s in stage_results
    ):
        return "PARTIAL_SUCCESS"
    return "SUCCESS"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--scope", default="speed")
    p.add_argument("--language", default=None, choices=["english", "chinese"])
    args = p.parse_args()

    started = time.time()
    ws = Workspace()
    # generation_report.json lives under 05_generation/; 06_output/ is created
    # only when a deliverable (PDF or Markdown fallback) actually exists, so a
    # deferred-fallback compile failure does not materialise an empty
    # 06_output/ before the agent's fix loop has run.
    ws.ensure_output_dirs(include_output=False)
    log_script_start(ws, "phase08_finalize",
                     scope=getattr(args, "scope", None),
                     language=getattr(args, "language", None))

    outline = load_outline(ws.root) if ws.outline_path.exists() else {}
    bootstrap = _load_status(ws, "phase00_bootstrap") or {}
    query_meta = load_json(ws.query_meta_path()) if ws.query_meta_path().exists() else {}

    if args.language:
        language = args.language
    else:
        language = query_meta.get("language", "english")

    whole_manuscript = (ws.gen / "_internal/manuscript_contract.json").exists()
    stage_timeline = []
    aggregate = []
    for phase, stage in _PHASE_TO_STAGE.items():
        if whole_manuscript and ("refin" in phase or phase in ("collect_drafting_worklist", "run_drafting", "validate_drafts")):
            continue
        st = _load_status(ws, phase)
        if not st:
            continue
        stage_timeline.append({
            "stage": stage,
            "phase": phase,
            "status": st.get("status"),
            "duration_sec": st.get("duration_sec"),
            "started_at": st.get("timestamp"),
        })
        aggregate.append(st)

    final_status = _final_status(aggregate)

    drafts_validate_st = _load_status(ws, "validate_drafts") or {}
    refine_validate_st = {} if whole_manuscript else (_load_status(ws, "validate_refined") or {})
    refine_run_st = {} if whole_manuscript else (_load_status(ws, "run_refinement") or {})
    table_st = _load_status(ws, "validate_tables") or {}
    figure_render_st = _load_status(ws, "generate_images") or {}
    figure_latex_st = _load_status(ws, "write_latex") or {}
    quality_st = _load_status(ws, "phase06_quality_check") or {}
    compile_st = _load_status(ws, "phase07_compile_latex") or {}
    # Cite-key stats come from phase05b, whose scan covers the v3 body plus the
    # tables/figures `\input{...}` subfiles (so cite keys used only inside a
    # table or figure are included).
    assets_st = _load_status(ws, "phase05b_insert_assets") or {}

    # ---- Per-section outcomes (built from artifacts + validator status) ----
    degraded_ids = set(drafts_validate_st.get("degraded") or [])
    # Drafting is a subagent fan-out (legacy section author), so there is no
    # drafting runner and no `run_drafting.json` status file to read
    # `failed_sections` from. `validate_drafts` is the hard gate on the
    # artefacts those agents write, and it is the artefact-based equivalent:
    #   missing[] = the worklist named a section with no draft json on disk
    #   invalid[] = a draft json exists but is unusable (unparseable, not an
    #               object, or a body_md under the length floor)
    # Both leave `validate_drafts` at PARTIAL_SUCCESS or FAILED, so
    # `final_status` is already non-SUCCESS whenever this set is non-empty.
    failed_drafting = {
        sid for sid in (drafts_validate_st.get("missing") or []) if sid
    } | {
        (f.get("section_id") if isinstance(f, dict) else f)
        for f in (drafts_validate_st.get("invalid") or [])
    }
    failed_drafting.discard(None)
    failed_refinement = {
        (f.get("section_id") if isinstance(f, dict) else f)
        for f in (refine_run_st.get("failed_sections") or [])
    }
    section_outcomes = []
    for p in sorted(ws.section_drafts_dir.glob("*.json")):
        sid = p.stem
        if sid in failed_drafting:
            sec_status = "FAILED"
        elif sid in degraded_ids:
            sec_status = "DEGRADED"
        else:
            sec_status = "SUCCESS"
        section_outcomes.append({
            "section_id": sid,
            "status": sec_status,
            "refined": False if whole_manuscript else (ws.full_draft_v2_path.exists() or (ws.gen / "full_draft_v2.md").exists()),
            "refinement_failed": sid in failed_refinement,
        })

    # ---- Per-figure outcomes (built from artifacts + render/latex status) ----
    figure_failed = {
        f.get("figure_id"): f.get("error")
        for f in (figure_render_st.get("failed") or [])
        if isinstance(f, dict)
    }
    figure_outcomes = []
    seen_figs = set()
    for p in sorted(ws.figures_dir.glob("*.tex")):
        fid = p.stem
        png = ws.figures_dir / f"{fid}.png"
        figure_outcomes.append({
            "figure_id": fid,
            "generated": png.exists(),
            "tex_present": True,
            "error": figure_failed.get(fid),
        })
        seen_figs.add(fid)
    for fid, err in figure_failed.items():
        if fid not in seen_figs:
            figure_outcomes.append({
                "figure_id": fid,
                "generated": False,
                "tex_present": False,
                "error": err,
            })

    # Token usage: scripts don't currently emit per-stage token counts; keep the
    # field in the report shape for downstream consumers but populate as 0.
    token_totals = {
        "section_drafts":       {"tokens_in": 0, "tokens_out": 0},
        "coherency_refinement": {"tokens_in": 0, "tokens_out": 0},
        "tables_generation":    {"tokens_in": 0, "tokens_out": 0},
    }
    totals_in = 0
    totals_out = 0

    report = {
        "task_id": query_meta.get("task_id") or bootstrap.get("task_id") or outline.get("task_id"),
        "topic": query_meta.get("topic") or outline.get("topic"),
        "module": "05_generation",
        "module_version": "0.1.0",
        "scope": args.scope,
        "language": language,
        "started_at": bootstrap.get("timestamp"),
        "completed_at": now_iso(),
        "final_status": final_status,
        "stage_timeline": stage_timeline,
        "section_outcomes": section_outcomes,
        "figure_outcomes": figure_outcomes,
        "tables": {
            "generated": table_st.get("written", 0),
            "failed": (
                list(table_st.get("missing") or [])
                + [it.get("table_id") for it in (table_st.get("invalid") or []) if isinstance(it, dict)]
            ),
            "total_specs": table_st.get("total", 0),
        },
        "figures": {
            "rendered": figure_render_st.get("rendered", 0),
            "forest_skipped": figure_render_st.get("forest_skipped", 0),
            "dropped": figure_latex_st.get("dropped", 0),
            "total": figure_render_st.get("total", figure_latex_st.get("total", 0)),
        },
        "quality": {
            "verdict": (quality_st.get("verdict") or "UNKNOWN"),
            "fatal_violations": quality_st.get("fatal_violations", 0),
            "warning_violations": quality_st.get("warning_violations", 0),
        },
        "compile": {
            "status": compile_st.get("status"),
            "engine": compile_st.get("engine"),
            "output": compile_st.get("output"),
            "warnings": compile_st.get("warnings", []),
            "errors": compile_st.get("errors", []),
        },
        "merge": {
            "cite_keys_used": assets_st.get("cite_keys_used", 0),
            "cite_keys_missing": assets_st.get("cite_keys_missing", []),
        },
        "token_usage": {
            "by_stage": token_totals,
            "totals": {"tokens_in": totals_in, "tokens_out": totals_out},
        },
        "artifacts_summary": {
            "section_drafts": len(list(ws.section_drafts_dir.glob("*.json"))),
            "figures": len(list(ws.figures_dir.glob("*.png"))),
            "figure_tex_wrappers": len(list(ws.figures_dir.glob("*.tex"))),
            "tables": len(list(ws.tables_dir.glob("*.tex"))),
            "full_draft_v1_tex": ws.full_draft_v1_path.exists(),
            "full_draft_v2_tex": ws.full_draft_v2_path.exists(),
            "full_draft_v3_tex": ws.full_draft_v3_path.exists(),
            "full_draft_v1_md": (ws.gen / "full_draft_v1.md").exists(),
            "full_draft_v2_md": (ws.gen / "full_draft_v2.md").exists(),
            "full_draft_v3_md": (ws.gen / "full_draft_v3.md").exists(),
            "citations_bib": ws.citations_bib_path.exists(),
            "quality_report": ws.quality_report_path.exists(),
            "pdf": ws.survey_pdf_path.exists(),
            # `survey_md` is the Markdown path's deliverable; `md_fallback` is
            # what the LaTeX path leaves when it could not produce a PDF. Both
            # keys are always present so the report has one shape.
            "survey_md": (ws.output / "survey.md").exists(),
            "md_fallback": ws.survey_md_fallback_path.exists(),
            # Self-contained LaTeX bundle mirrored into 06_output/ by phase 7.
            "survey_tex": ws.survey_tex_path.exists(),
            "survey_citations_bib": ws.survey_citations_bib_path.exists(),
            "survey_figures_count": (
                len(list(ws.survey_figures_dir.iterdir()))
                if ws.survey_figures_dir.exists() else 0
            ),
            "survey_tables_count": (
                len(list(ws.survey_tables_dir.iterdir()))
                if ws.survey_tables_dir.exists() else 0
            ),
            "survey_neurips_sty": ws.survey_neurips_sty_path.exists(),
        },
    }

    # ---- Downstream handoff (verifier input) — uniform across scopes ----
    # `full_draft` points at the deepest stage that exists on disk so the
    # downstream verifier always reads the most-processed version. Both
    # dialects are probed, deepest first, without asking which path ran: only
    # one of them ever has files.
    full_draft_for_verifier = next(
        (path for path in (
            ws.full_draft_v3_path, ws.gen / "full_draft_v3.md",
            ws.full_draft_v2_path, ws.gen / "full_draft_v2.md",
            ws.full_draft_v1_path, ws.gen / "full_draft_v1.md",
        ) if path.exists()),
        ws.full_draft_v1_path,
    )
    report["downstream_handoff"] = {
        "verifier_input": {
            "full_draft": str(full_draft_for_verifier),
            "full_draft_v1": str(ws.full_draft_v1_path),
            "full_draft_v2": str(ws.full_draft_v2_path),
            "full_draft_v3": str(ws.full_draft_v3_path),
            "citations_bib": str(ws.citations_bib_path),
            "quality_report": str(ws.quality_report_path),
        }
    }

    write_json(ws.generation_report_path, report)

    # ---- Disclaimer -----------------------------------------------------
    # The disclaimer accompanies a deliverable, so it is only written once one
    # exists in 06_output/. On a deferred-fallback compile failure (no PDF and
    # no Markdown fallback yet) we skip it entirely — and skip creating
    # 06_output/ — leaving it for the re-finalize that runs after the agent's
    # compile fix loop has produced a PDF or emitted the fallback.
    topic = report["topic"] or "(unknown topic)"
    task_id = report["task_id"] or "(no task_id)"
    completed = report["completed_at"]
    deliverable = _deliverable(ws, compile_st)
    if deliverable is None:
        output_form = "pending (compile fix loop)"
    elif deliverable == ws.survey_md_fallback_path:
        output_form = "Markdown fallback"
    else:
        output_form = _OUTPUT_FORM.get(deliverable.suffix.lower(), "document")

    disclaimer_written = False
    if deliverable is None:
        # No deliverable yet — do not touch 06_output/.
        write_status(
            ws, "phase08_finalize", "SUCCESS",
            duration_sec=round(time.time() - started, 2),
            scope=args.scope,
            language=language,
            final_status=final_status,
            output_form=output_form,
            deliverable=None,
            report_path=str(ws.generation_report_path),
            disclaimer_path=None,
            survey_pdf_path=None,
            survey_md_fallback_path=None,
        )
        return 0

    ws.output.mkdir(parents=True, exist_ok=True)
    if language == "chinese":
        disclaimer = (
            "# 免责声明\n\n"
            f"> 主题: **{topic}**\n"
            f"> 任务 ID: `{task_id}`\n"
            f"> Scope: {args.scope}\n"
            f"> 语言: {language}\n"
            f"> 生成时间: {completed}\n"
            f"> 输出形式: {output_form}\n\n"
            "本文档由 AI 自动生成，引用文献与结论均可能存在错误或遗漏。"
            "**请在正式引用或决策前人工核实关键文献与论断**。"
            "本系统不对任何因使用本文档内容造成的后果承担责任。\n"
        )
    else:
        disclaimer = (
            "# Disclaimer\n\n"
            f"> Topic: **{topic}**\n"
            f"> Task ID: `{task_id}`\n"
            f"> Scope: {args.scope}\n"
            f"> Language: {language}\n"
            f"> Generated at: {completed}\n"
            f"> Output form: {output_form}\n\n"
            "This document was automatically generated by AI. Citations and "
            "conclusions may contain errors or omissions. **Please verify "
            "key references and claims manually before formal citation or "
            "decision-making.** The system assumes no responsibility for "
            "consequences arising from the use of this document.\n"
        )
    ws.disclaimer_path.write_text(disclaimer, encoding="utf-8")
    disclaimer_written = True

    write_status(
        ws, "phase08_finalize", "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        scope=args.scope,
        language=language,
        final_status=final_status,
        output_form=output_form,
        deliverable=str(deliverable),
        report_path=str(ws.generation_report_path),
        disclaimer_path=str(ws.disclaimer_path) if disclaimer_written else None,
        survey_pdf_path=str(ws.survey_pdf_path) if ws.survey_pdf_path.exists() else None,
        survey_md_fallback_path=(
            str(ws.survey_md_fallback_path) if ws.survey_md_fallback_path.exists() else None
        ),
    )

    reasons: list[str] = []
    if final_status != "SUCCESS":
        n_degraded = len(degraded_ids)
        n_draft_fail = len(failed_drafting)
        n_refine_fail = len(failed_refinement)
        if n_draft_fail:
            reasons.append(f"{n_draft_fail} section drafts failed")
        if n_degraded:
            reasons.append(f"{n_degraded} sections degraded")
        if n_refine_fail:
            reasons.append(f"{n_refine_fail} sections refinement failed")
        failed_tables = report["tables"]["failed"]
        if failed_tables:
            reasons.append(f"{len(failed_tables)} tables failed")
        # Image generation is disabled in this deployment, so every image-mode
        # figure lands in generate_images' failed[] by design — report those as
        # skipped and keep "failed" for genuinely broken figures.
        skipped_figs = [fid for fid, err in figure_failed.items()
                        if "image generation disabled" in (err or "")]
        broken_figs = [fid for fid in figure_failed if fid not in set(skipped_figs)]
        if skipped_figs:
            reasons.append(f"{len(skipped_figs)} figures skipped (image generation disabled)")
        if broken_figs:
            reasons.append(f"{len(broken_figs)} figures failed")
        if quality_st.get("verdict") == "FAIL":
            reasons.append(f"quality check FAIL ({quality_st.get('fatal_violations', 0)} fatal)")
        elif quality_st.get("verdict") == "PASS_WITH_WARNINGS":
            reasons.append(f"quality check has {quality_st.get('warning_violations', 0)} warnings")
        # The publish step reports itself in its own terms. A Markdown run's
        # PARTIAL_SUCCESS means citations were dropped, not that a compile fell
        # back to anything, and saying otherwise would send the reader to a
        # LaTeX log that does not exist.
        if compile_st.get("engine") == "markdown":
            unresolved = (compile_st.get("citation_metrics") or {}).get(
                "citations_unresolved") or []
            if unresolved:
                reasons.append(
                    f"{len(unresolved)} citation(s) had no bibliography entry")
            elif compile_st.get("status") in ("FAILED", "PARTIAL_SUCCESS"):
                reasons.append(
                    f"markdown publish {compile_st.get('status')}: "
                    f"{compile_st.get('message') or 'see phase07 status'}")
        elif compile_st.get("status") == "FAILED":
            reasons.append("LaTeX compile failed, fell back to Markdown")
        elif compile_st.get("status") == "PARTIAL_SUCCESS":
            reasons.append("LaTeX compile fell back to Markdown")
        for st_entry in stage_timeline:
            if st_entry["status"] == "FAILED":
                reasons.append(f"stage {st_entry['stage']} FAILED")
                break

    handshake = {
        "status": final_status,
        "task": "PAPER_GENERATION",
        "status_reason": "; ".join(reasons) if reasons else "SUCCESS",
    }
    print(json.dumps(handshake, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
