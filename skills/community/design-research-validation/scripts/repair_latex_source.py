#!/usr/bin/env scholarseed-skill-python
"""Recover a likely LaTeX body before a downstream token budget is applied.

This utility is intentionally format-only: it does not infer a discipline,
claim, experiment type, or scientific schema.  It repairs only inputs that the
high-precision source preflight already classified as a truncated preamble.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Keep the sibling module discoverable under the product runner's PYTHONSAFEPATH.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from source_preflight import assess_text  # noqa: E402 - standalone script bootstrap


BEGIN_DOCUMENT = re.compile(r"\\begin\s*\{\s*document\s*\}", re.IGNORECASE)
BODY_START = re.compile(
    r"\\(?:begin\s*\{\s*(?:abstract|theorem|lemma|proposition|corollary|"
    r"definition|proof)\s*\}|section\*?\s*\{|chapter\*?\s*\{|paragraph\*?\s*\{)",
    re.IGNORECASE,
)
MIN_RECOVERED_TOKENS = 80


def repair_text(text: str) -> tuple[str, dict[str, Any]]:
    """Return a body-first source and an auditable, deterministic report."""
    original = assess_text(text)
    begin = BEGIN_DOCUMENT.search(text)
    body = BODY_START.search(text)
    if begin:
        start = begin.end()
        prefix_end = begin.start()
        method = "after_begin_document"
    elif body:
        start = body.start()
        prefix_end = body.start()
        method = "at_first_body_marker"
    else:
        return text, {
            "status": "not_repaired",
            "reason_code": "no_body_marker_in_original_source",
            "start_character": None,
            "recovered_tokens": 0,
            "assessment_before": original,
            "assessment_after": original,
        }

    # A complete original correctly passes the source preflight because it has
    # a body marker.  Assess its prefix separately to prove that the selected
    # cut point is preceded by the same high-confidence macro-heavy preamble.
    prefix_assessment = assess_text(text[:prefix_end])
    prefix_signals = prefix_assessment.get("signals", {})
    explicit_document_boundary = bool(begin) and all(
        (
            prefix_signals.get("document_class_near_start") is True,
            int(prefix_signals.get("preamble_command_count") or 0) >= 64,
            int(prefix_signals.get("macro_definition_count") or 0) >= 32,
            int(prefix_signals.get("total_command_count") or 0) >= 128,
        )
    )
    if (
        prefix_assessment.get("reason_code") != "latex_preamble_only"
        and not explicit_document_boundary
    ):
        return text, {
            "status": "unchanged",
            "reason_code": "prefix_not_classified_as_latex_preamble_only",
            "start_character": 0,
            "recovered_tokens": len(text.split()),
            "assessment_before": original,
            "prefix_assessment": prefix_assessment,
            "assessment_after": original,
        }

    repaired = text[start:].lstrip()
    recovered_tokens = len(re.findall(r"\b\w+\b", repaired, flags=re.UNICODE))
    after = assess_text(repaired)
    if recovered_tokens < MIN_RECOVERED_TOKENS:
        return text, {
            "status": "not_repaired",
            "reason_code": "recovered_body_too_short",
            "start_character": start,
            "recovered_tokens": recovered_tokens,
            "assessment_before": original,
            "assessment_after": after,
        }
    return repaired, {
        "status": "repaired",
        "reason_code": method,
        "start_character": start,
        "recovered_tokens": recovered_tokens,
        "assessment_before": original,
        "prefix_assessment": prefix_assessment,
        "assessment_after": after,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recover a LaTeX body from a source classified as preamble-only"
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    source = args.source.read_text(encoding="utf-8")
    repaired, report = repair_text(source)
    if report["status"] in {"repaired", "unchanged"}:
        args.output.write_text(repaired, encoding="utf-8")
    if args.report:
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] in {"repaired", "unchanged"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
