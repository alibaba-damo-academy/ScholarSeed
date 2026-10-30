#!/usr/bin/env scholarseed-skill-python
"""High-precision, domain-neutral source sufficiency preflight.

The gate intentionally returns ``unknown`` rather than guessing for formats it
cannot classify safely.  Only ``insufficient`` is a reason to skip scientific
generation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


DOCUMENT_CLASS = re.compile(r"\\documentclass(?:\s*\[[^]]*\])?\s*\{", re.IGNORECASE)
BEGIN_DOCUMENT = re.compile(r"\\begin\s*\{\s*document\s*\}", re.IGNORECASE)
PREAMBLE_COMMAND = re.compile(
    r"\\(?:usepackage|newcommand|renewcommand|providecommand|def|DeclareMathOperator|"
    r"setlength|newtheorem|titleformat|hypersetup)\b",
    re.IGNORECASE,
)
MACRO_DEFINITION = re.compile(
    r"\\(?:newcommand|renewcommand|providecommand|def|DeclareMathOperator)\b",
    re.IGNORECASE,
)
LATEX_COMMAND = re.compile(r"\\[A-Za-z@]+")
BODY_MARKER = re.compile(
    r"\\(?:begin\s*\{\s*(?:document|abstract|theorem|lemma|proposition|"
    r"corollary|definition|proof)\s*\}|section\*?\s*\{|chapter\*?\s*\{|"
    r"paragraph\*?\s*\{)",
    re.IGNORECASE,
)
MIN_SETUP_COMMANDS = 64
MIN_MACRO_DEFINITIONS = 32
MIN_TOTAL_COMMANDS = 128


def assess_text(text: str) -> dict[str, Any]:
    """Return a conservative sufficiency assessment without domain inference."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not text.strip():
        return {
            "status": "insufficient",
            "reason_code": "empty_source",
            "format": "empty",
            "signals": {"characters": 0},
        }

    document_class = DOCUMENT_CLASS.search(text)
    begin_document = BEGIN_DOCUMENT.search(text)
    preamble_commands = len(PREAMBLE_COMMAND.findall(text))
    macro_definitions = len(MACRO_DEFINITION.findall(text))
    total_commands = len(LATEX_COMMAND.findall(text))
    body_marker = BODY_MARKER.search(text)
    looks_like_latex_document = bool(
        document_class and document_class.start() <= min(len(text), 1000)
    )

    signals = {
        "characters": len(text),
        "document_class_near_start": looks_like_latex_document,
        "begin_document": bool(begin_document),
        "body_marker": bool(body_marker),
        "preamble_command_count": preamble_commands,
        "macro_definition_count": macro_definitions,
        "total_command_count": total_commands,
    }
    if (
        looks_like_latex_document
        and not body_marker
        and preamble_commands >= MIN_SETUP_COMMANDS
        and macro_definitions >= MIN_MACRO_DEFINITIONS
        and total_commands >= MIN_TOTAL_COMMANDS
    ):
        return {
            "status": "insufficient",
            "reason_code": "latex_preamble_only",
            "format": "latex",
            "signals": signals,
        }
    if body_marker:
        return {
            "status": "sufficient",
            "reason_code": "latex_document_body_present",
            "format": "latex",
            "signals": signals,
        }
    return {
        "status": "unknown",
        "reason_code": "no_high_confidence_rule",
        "format": "text",
        "signals": signals,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Conservatively detect empty or LaTeX-preamble-only research input"
    )
    parser.add_argument("source", help="UTF-8 text file, or - to read stdin")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.source == "-":
        text = sys.stdin.read()
    else:
        text = Path(args.source).read_text(encoding="utf-8")
    print(json.dumps(assess_text(text), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
