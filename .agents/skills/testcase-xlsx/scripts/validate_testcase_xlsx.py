#!/usr/bin/env python3
"""Validate testcase workbook structure and required data."""

from __future__ import annotations

import argparse
from pathlib import Path

from openpyxl import load_workbook
from testcase_schema import HEADER_TO_KEY, HEADERS, REQUIRED, SHEET_NAME, VALID_PRIORITIES


def validate_workbook(path: Path, expected_count: int | None = None) -> int:
    workbook = load_workbook(path, read_only=True, data_only=True)
    if SHEET_NAME not in workbook.sheetnames:
        raise ValueError(f"Missing sheet {SHEET_NAME!r}")
    sheet = workbook[SHEET_NAME]
    headers = [sheet.cell(1, col).value for col in range(1, len(HEADERS) + 1)]
    if headers != HEADERS:
        raise ValueError(f"Invalid headers: {headers}")
    count = 0
    for row in range(2, sheet.max_row + 1):
        values = {
            HEADER_TO_KEY[HEADERS[col - 1]]: sheet.cell(row, col).value
            for col in range(1, len(HEADERS) + 1)
        }
        if not any(value not in (None, "") for value in values.values()):
            continue
        count += 1
        missing = [
            key for key in REQUIRED if values.get(key) is None or not str(values[key]).strip()
        ]
        if missing:
            raise ValueError(f"Row {row} missing required fields: {missing}")
        if str(values["priority"]).strip() not in VALID_PRIORITIES:
            raise ValueError(f"Row {row} has invalid priority")
    if expected_count is not None and count != expected_count:
        raise ValueError(f"Expected {expected_count} cases, found {count}")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--expected-count", type=int)
    args = parser.parse_args()
    print(f"Validated {validate_workbook(args.input, args.expected_count)} cases: {args.input}")


if __name__ == "__main__":
    main()
