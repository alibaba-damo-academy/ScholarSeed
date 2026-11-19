#!/usr/bin/env python3
"""Build and validate a testcase workbook from JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from testcase_schema import DEFAULTS, HEADERS, KEYS, SHEET_NAME, normalize_multiline, validate_cases
from validate_testcase_xlsx import validate_workbook


def load_cases(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cases = data.get("cases", []) if isinstance(data, dict) else data
    if not isinstance(cases, list) or not all(isinstance(case, dict) for case in cases):
        raise ValueError("JSON must be a case list or an object containing a 'cases' list")
    if isinstance(data, dict) and "case_count" in data and int(data["case_count"]) != len(cases):
        raise ValueError("Declared case_count does not match cases length")
    return cases


def build(output: Path, cases: list[dict]) -> None:
    validate_cases(cases)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = SHEET_NAME
    sheet.append(HEADERS)
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="4472C4")
        cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = "A1:L1"
    for case in cases:
        complete = {**DEFAULTS, **case}
        sheet.append([normalize_multiline(complete.get(key, "")) for key in KEYS])
    for row in sheet.iter_rows(min_row=2, max_col=len(HEADERS)):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    for index, width in enumerate([12, 40, 24, 12, 10, 10, 30, 10, 50, 50, 16, 30], 1):
        sheet.column_dimensions[chr(64 + index)].width = width
    output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output)
    validate_workbook(output, len(cases))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cases = load_cases(args.cases)
    build(args.output, cases)
    print(f"Wrote and validated {len(cases)} cases: {args.output}")


if __name__ == "__main__":
    main()
