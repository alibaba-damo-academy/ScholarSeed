#!/usr/bin/env python3
"""Extract a testcase workbook to editable JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from openpyxl import load_workbook
from testcase_schema import HEADER_TO_KEY, KEYS, SHEET_NAME


def clean(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def extract(path: Path, sheet_name: str) -> list[dict]:
    workbook = load_workbook(path, data_only=True)
    if sheet_name not in workbook.sheetnames:
        raise ValueError(f"Missing sheet {sheet_name!r}")
    sheet = workbook[sheet_name]
    mapping = {
        cell.column: HEADER_TO_KEY[clean(cell.value)]
        for cell in sheet[1]
        if clean(cell.value) in HEADER_TO_KEY
    }
    missing = [key for key in KEYS if key not in mapping.values()]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")
    cases = []
    for row in range(2, sheet.max_row + 1):
        record = {key: clean(sheet.cell(row, col).value) for col, key in mapping.items()}
        if any(str(value).strip() for value in record.values()):
            cases.append(record)
    return cases


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sheet", default=SHEET_NAME)
    args = parser.parse_args()
    cases = extract(args.input, args.sheet)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {"sheet": args.sheet, "case_count": len(cases), "cases": cases},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(cases)} cases: {args.output}")


if __name__ == "__main__":
    main()
