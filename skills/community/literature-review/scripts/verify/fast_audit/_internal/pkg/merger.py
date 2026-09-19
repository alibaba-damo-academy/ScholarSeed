"""Fast-audit merger — aggregate the 6 module artefacts into one report."""

import time
from datetime import datetime, timezone


# (key, tier, subdir, filename) — order fixed; mirrors public MODULES.md
MODULES = [
    ("placeholder",              "S", "tmp",    "citation_placeholder.json"),
    ("content_quality",          "S", "output", "content_quality_result.json"),
    ("latex_safety",             "S", "output", "latex_safety_result.json"),
    ("integrity",                "S", "output", "integrity_result.json"),
    ("crossfield",               "S", "tmp",    "citation_crossfield.json"),
    ("citation_reality_offline", "S", "output", "citation_reality_result.json"),
    ("coverage",                 "A", "output", "coverage_result.json"),
    ("relevance",                "A", "output", "relevance_result.json"),
]


def _eval_placeholder(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    count = payload.get("placeholder_count")
    if count is None:
        count = sum(1 for r in payload.get("results", [])
                    if isinstance(r, dict) and r.get("is_placeholder"))
    # Mirrors runtime/cli.py::_run_placeholder which maps count>0 →
    # PARTIAL_SUCCESS (not REJECTED). Unsubstituted placeholders should be
    # surfaced for human review without blocking — some legit drafts include
    # template strings that look like placeholders to the heuristic.
    status = "WARN" if count and count > 0 else "PASS"
    return status, {
        "placeholder_count": count,
        "total": payload.get("total", len(payload.get("results", []))),
    }


def _eval_content_quality(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    passed = payload.get("passed", True)
    # Mirrors runtime/cli.py::_run_content_quality (PARTIAL_SUCCESS on
    # template/cliché detection). Template heuristics are pattern-based and
    # prone to false positives on legitimate prose — surface for review,
    # don't block.
    return ("PASS" if passed else "WARN", {
        "passed": passed,
        "template_ratio": payload.get("template_ratio"),
        "critical_matches": payload.get("critical_matches"),
    })


def _eval_latex_safety(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    passed = payload.get("passed", True)
    return ("PASS" if passed else "FAIL", {
        "passed": passed,
        "image_placeholder_count": payload.get("image_placeholder_count", 0),
        "unescaped_percent_count": payload.get("unescaped_percent_count", 0),
        "failed_figures_referenced":
            payload.get("failed_figures_referenced", []),
    })


def _eval_integrity(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    severity = payload.get("severity", "PASS")
    # Mirrors runtime/cli.py::_run_integrity which maps WARN → PARTIAL_SUCCESS
    # at the per-module level. Without WARN here the merger would silently
    # flatten lenient-section unverified numbers into PASS.
    if severity == "REJECT":
        status = "FAIL"
    elif severity == "WARN":
        status = "WARN"
    else:
        status = "PASS"
    return status, {
        "severity": severity,
        "fabrication_rate": payload.get("fabrication_rate"),
        "total_numbers": payload.get("total_numbers"),
        "verified_numbers": payload.get("verified_numbers"),
    }


def _eval_crossfield(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    inconsistent = payload.get("inconsistent_count", 0)
    if inconsistent is None:
        inconsistent = sum(1 for r in payload.get("results", [])
                           if isinstance(r, dict) and not r.get("consistent", True))
    # Mirrors runtime/cli.py::_run_crossfield (PARTIAL_SUCCESS, not REJECTED).
    # Crossfield compares claimed citation metadata against db_metadata.json;
    # mismatches are often metadata drift (year off by 1, author transliteration
    # variants) rather than fabrications. WARN surfaces for review.
    status = "WARN" if inconsistent and inconsistent > 0 else "PASS"
    return status, {"inconsistent_count": inconsistent, "total": payload.get("total")}


def _eval_coverage(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    f1 = payload.get("coverage_f1")
    if f1 is None:
        # cross_lingual_skipped or otherwise unscoreable
        return "SKIPPED", {"coverage_f1": None,
                           "reason": payload.get("reason",
                                                 "coverage_f1 not computed")}
    # Mirror relevance's minimum-sample-size gate. keyword_topic_coverage
    # needs `min_papers_per_topic` (default 3) shared occurrences to define
    # a topic; with fewer than 3 papers in the scored bucket the recall is
    # structurally 1.0 (topics=∅) or 0.0 (any miss), so F1 is noise.
    scored_papers = payload.get("scored_papers", 0) or 0
    if scored_papers and scored_papers < 3:
        return "SKIPPED", {"coverage_f1": f1, "scored_papers": scored_papers,
                           "reason": f"scored_papers={scored_papers} < 3"}
    # Threshold 0.7 mirrors runtime/cli.py::_run_coverage (was 0.5 here).
    # F1 below 0.7 surfaces as WARN (A-tier soft signal) rather than FAIL —
    # TF-IDF coverage scoring on small section/paper sets is noisy; only the
    # cli's stricter judgment is taken as authoritative.
    status = "PASS" if f1 >= 0.7 else "WARN"
    return status, {"coverage_f1": f1,
                    "scored_papers": scored_papers or payload.get(
                        "semantic_alignment", {}).get("total_papers")}


def _eval_relevance(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    total = payload.get("total", 0)
    failed = payload.get("failed", 0)
    skipped = payload.get("skipped", 0)
    effective = total - skipped              # exclude cross-lingual skips
    # Need a minimum sample size before a majority-fail rule is statistically
    # meaningful — a single TF-IDF mismatch shouldn't flip the module. When
    # effective is small but ALL pairs passed, surface PASS rather than
    # SKIPPED (no red signal is itself useful info).
    if effective < 5:
        if effective > 0 and failed == 0:
            return "PASS", {"total": total, "failed": 0, "skipped": skipped,
                            "effective": effective,
                            "reason": "below-min sample, all pass"}
        return "SKIPPED", {"total": total, "failed": failed,
                           "skipped": skipped, "effective": effective,
                           "reason": "insufficient effective pairs (<5)"}
    # Threshold 0.8 mirrors runtime/cli.py::_run_relevance (was 0.5 here).
    # IDF-weighted cosine puts most pairs near the band boundary; a 50%
    # failure rate is too easy to hit on noisy abstracts. Only >80% failed
    # constitutes a hard FAIL signal; anything above 0 but below 80% is a
    # WARN surfaced for review without blocking the verdict.
    if failed > effective * 0.8:
        status = "FAIL"
    elif failed > 0:
        status = "WARN"
    else:
        status = "PASS"
    return status, {"total": total, "failed": failed,
                    "skipped": skipped, "effective": effective}


def _eval_citation_reality(payload: dict) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        return "FAIL", {"error": "invalid payload type"}
    hallucinated = payload.get("hallucinated", 0) or 0
    suspicious = payload.get("suspicious", 0) or 0
    total = payload.get("total", 0) or 0
    if hallucinated > 0:
        status = "FAIL"
    elif suspicious > 0:
        # SUSPICIOUS = "needs human review" soft signal (cite_key in
        # cite_keys.json but lost from .bib, bib year invalid/0/future, or
        # bib.title vs paper_card.title in the 0.50–0.92 band). Not a hard
        # hallucination → escalate verdict to PARTIAL_SUCCESS, not REJECTED.
        # Mirrors runtime/cli.py::_run_citation_reality which already maps
        # PARTIAL_SUSPICIOUS → StatusCode.PARTIAL_SUCCESS at the per-module
        # level; without WARN here the merger silently flattened it to PASS.
        status = "WARN"
    else:
        status = "PASS"
    return status, {
        "total":        total,
        "verified":     payload.get("verified", 0),
        "suspicious":   suspicious,
        "hallucinated": hallucinated,
        "skipped":      payload.get("skipped", 0),
        "to_remove":    payload.get("to_remove", [])[:10],
    }


_EVALUATORS = {
    "placeholder":              _eval_placeholder,
    "content_quality":          _eval_content_quality,
    "latex_safety":             _eval_latex_safety,
    "integrity":                _eval_integrity,
    "crossfield":               _eval_crossfield,
    "citation_reality_offline": _eval_citation_reality,
    "coverage":                 _eval_coverage,
    "relevance":                _eval_relevance,
}


def merge(workspace_io) -> dict:
    """Aggregate the 6 fast-audit modules; workspace_io provides file access."""
    started = time.perf_counter()
    module_results: dict = {}
    failed: list[str] = []
    warned: list[str] = []
    skipped: list[str] = []
    passed: list[str] = []

    for key, tier, subdir, fname in MODULES:
        source_path = f"{subdir}/{fname}"
        if not workspace_io.exists(subdir, fname):
            module_results[key] = {
                "status": "SKIPPED",
                "tier": tier,
                "key_signal": {"reason": "source_file_missing"},
                "source_file": source_path,
            }
            skipped.append(key)
            continue
        try:
            payload = workspace_io.read_json(subdir, fname)
        except Exception as e:
            module_results[key] = {
                "status": "TOOL_UNAVAILABLE",
                "tier": tier,
                "key_signal": {"error": str(e)},
                "source_file": source_path,
            }
            failed.append(key)
            continue

        status, signal = _EVALUATORS[key](payload)
        module_results[key] = {
            "status": status,
            "tier": tier,
            "key_signal": signal,
            "source_file": source_path,
        }
        if status == "PASS":
            passed.append(key)
        elif status == "SKIPPED":
            skipped.append(key)
        elif status == "WARN":
            warned.append(key)
        else:
            failed.append(key)

    s_failed = [k for k in failed
                if module_results[k]["tier"] == "S" and module_results[k]["status"] == "FAIL"]
    a_failed = [k for k in failed
                if module_results[k]["tier"] == "A" and module_results[k]["status"] == "FAIL"]
    s_warned = [k for k in warned if module_results[k]["tier"] == "S"]
    a_warned = [k for k in warned if module_results[k]["tier"] == "A"]
    tool_unavailable = [k for k, r in module_results.items() if r["status"] == "TOOL_UNAVAILABLE"]

    if len(skipped) + len(tool_unavailable) == len(MODULES):
        verdict = "TOOL_UNAVAILABLE"
        recommendation = (
            "All fast-audit source files missing. Run the per-module CLI "
            "subcommands first (placeholder/content_quality/latex_safety/"
            "integrity/crossfield/citation_reality_offline/coverage/relevance) "
            "— see CONTRACT.md."
        )
    elif s_failed:
        verdict = "REJECTED"
        recommendation = (
            f"REJECTED — S-tier modules failed: {', '.join(s_failed)}. "
            "Fix the surfaced issues before running heavier verification."
        )
    elif s_warned or a_failed or a_warned:
        verdict = "PARTIAL_SUCCESS"
        parts: list[str] = []
        if s_warned:
            parts.append(
                f"S-tier soft signals (manual review): {', '.join(s_warned)}"
            )
        if a_failed:
            parts.append(f"A-tier soft failures: {', '.join(a_failed)}")
        if a_warned:
            parts.append(f"A-tier soft signals: {', '.join(a_warned)}")
        recommendation = (
            "PARTIAL_SUCCESS — " + "; ".join(parts)
            + ". Review final_report.md before publishing; S-tier soft "
              "signals do not block but warrant manual sanity check."
        )
    else:
        verdict = "PASS"
        recommendation = (
            "PASS — all deterministic gates clean."
        )

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "elapsed_ms": round(elapsed_ms, 4),
        "verdict": verdict,
        "module_results": module_results,
        "failed_modules": [k for k in failed if module_results[k]["status"] == "FAIL"],
        "warned_modules": warned,
        "skipped_modules": skipped,
        "tool_unavailable_modules": tool_unavailable,
        "recommendation": recommendation,
        "modules_evaluated": len(MODULES),
        "modules_passed": len(passed),
        "modules_failed": len([k for k in failed if module_results[k]["status"] == "FAIL"]),
        "modules_warned": len(warned),
        "modules_skipped": len(skipped),
    }
