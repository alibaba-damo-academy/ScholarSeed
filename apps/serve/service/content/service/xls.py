"""Legacy BIFF XLS processor owned independently from OOXML XLSX."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Iterable

import xlrd
from openpyxl.utils.cell import get_column_letter, range_boundaries
from xlrd import (
    XL_CELL_BOOLEAN,
    XL_CELL_DATE,
    XL_CELL_EMPTY,
    XL_CELL_ERROR,
    XL_CELL_NUMBER,
    XL_CELL_TEXT,
)
from xlrd.biffh import XLRDError

from service.content.service.sheet import (
    SpreadsheetProcessor,
    SpreadsheetProcessorKind,
    SpreadsheetRangeContent,
    SpreadsheetRangeError,
    SpreadsheetRangeTooLarge,
)

XLS_SUFFIX = ".xls"
NUMBER_PATTERN = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$")
MAXIMUM_NUMBER_CHARS = 128
MAXIMUM_DECIMAL_EXPANSION = 64


def _normalized_decimal(value: str) -> str:
    stripped = value.strip()
    if (
        not stripped
        or len(stripped) > MAXIMUM_NUMBER_CHARS
        or NUMBER_PATTERN.fullmatch(stripped) is None
    ):
        return value
    try:
        number = Decimal(stripped)
    except InvalidOperation:
        return value
    if not number.is_finite() or abs(number.adjusted()) > MAXIMUM_DECIMAL_EXPANSION:
        return value
    normalized = format(number, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return "0" if normalized in ("-0", "+0") else normalized


def _range_bounds(
    selected_range: str,
    *,
    maximum_row: int,
    maximum_column: int,
) -> tuple[int, int, int, int]:
    try:
        minimum_column, minimum_row, selected_maximum_column, selected_maximum_row = (
            range_boundaries(selected_range)
        )
    except ValueError as exc:
        raise SpreadsheetRangeError("invalid_spreadsheet_range") from exc
    if maximum_row < 1 or maximum_column < 1:
        raise SpreadsheetRangeError("empty_spreadsheet")
    minimum_column = minimum_column or 1
    minimum_row = minimum_row or 1
    maximum_column = min(selected_maximum_column or maximum_column, maximum_column)
    maximum_row = min(selected_maximum_row or maximum_row, maximum_row)
    if minimum_column > maximum_column or minimum_row > maximum_row:
        raise SpreadsheetRangeError("empty_spreadsheet_range")
    return minimum_column, minimum_row, maximum_column, maximum_row


def _render_range(
    rows: Iterable[Iterable[str]],
    *,
    minimum_column: int,
    minimum_row: int,
    maximum_column: int,
    maximum_row: int,
    max_chars: int,
) -> SpreadsheetRangeContent:
    materialized = [tuple(row) for row in rows]
    while materialized and not any(cell for cell in materialized[-1]):
        materialized.pop()
        maximum_row -= 1
    if not materialized:
        raise SpreadsheetRangeError("empty_spreadsheet_range")
    populated_columns = [
        index
        for index in range(maximum_column - minimum_column + 1)
        if any(index < len(row) and row[index] for row in materialized)
    ]
    if not populated_columns:
        raise SpreadsheetRangeError("empty_spreadsheet_range")
    maximum_column = minimum_column + populated_columns[-1]
    column_count = maximum_column - minimum_column + 1
    rendered: list[str] = []
    rendered_chars = 0
    for row in materialized:
        line = "\t".join(row[:column_count])
        next_chars = rendered_chars + len(line) + (1 if rendered else 0)
        if next_chars > max_chars:
            raise SpreadsheetRangeTooLarge("spreadsheet_range_too_large")
        rendered.append(line)
        rendered_chars = next_chars
    return SpreadsheetRangeContent(
        text="\n".join(rendered),
        selected_range=(
            f"{get_column_letter(minimum_column)}{minimum_row}:"
            f"{get_column_letter(maximum_column)}{maximum_row}"
        ),
    )


def _cell_text(book: xlrd.book.Book, cell: xlrd.sheet.Cell) -> str:
    if cell.ctype == XL_CELL_EMPTY:
        return ""
    if cell.ctype == XL_CELL_TEXT:
        return str(cell.value)
    if cell.ctype == XL_CELL_NUMBER:
        return _normalized_decimal(str(cell.value))
    if cell.ctype == XL_CELL_DATE:
        return xlrd.xldate_as_datetime(float(cell.value), book.datemode).isoformat()
    if cell.ctype == XL_CELL_BOOLEAN:
        return str(bool(cell.value))
    if cell.ctype == XL_CELL_ERROR:
        error_code = int(cell.value)
        return xlrd.error_text_from_code.get(error_code, f"#ERROR:{error_code}")
    return str(cell.value)


def read_range(
    payload: bytes,
    sheet_name: str,
    selected_range: str,
    max_chars: int,
) -> SpreadsheetRangeContent:
    """Read one range from a legacy BIFF workbook."""

    try:
        workbook = xlrd.open_workbook(file_contents=payload, on_demand=True)
    except (XLRDError, OSError) as exc:
        raise SpreadsheetRangeError("invalid_spreadsheet") from exc
    try:
        try:
            sheet = workbook.sheet_by_name(sheet_name)
        except (XLRDError, IndexError) as exc:
            raise SpreadsheetRangeError("spreadsheet_sheet_missing") from exc
        minimum_column, minimum_row, maximum_column, maximum_row = _range_bounds(
            selected_range,
            maximum_row=sheet.nrows,
            maximum_column=sheet.ncols,
        )
        rows = (
            (
                _cell_text(workbook, sheet.cell(row_index, column_index))
                for column_index in range(minimum_column - 1, maximum_column)
            )
            for row_index in range(minimum_row - 1, maximum_row)
        )
        return _render_range(
            rows,
            minimum_column=minimum_column,
            minimum_row=minimum_row,
            maximum_column=maximum_column,
            maximum_row=maximum_row,
            max_chars=max_chars,
        )
    finally:
        workbook.release_resources()


PROCESSOR = SpreadsheetProcessor(
    kind=SpreadsheetProcessorKind.XLS,
    inspect=None,
    preview=None,
    decode=None,
    read_range=read_range,
)


__all__ = ["PROCESSOR", "XLS_SUFFIX", "read_range"]
