"""Spreadsheet processor registry and CSV implementation owned by Content."""

from __future__ import annotations

import csv
import re
from decimal import Decimal, InvalidOperation
from io import StringIO
from pathlib import Path
from types import MappingProxyType
from typing import Iterable, Mapping

from openpyxl.utils.cell import get_column_letter, range_boundaries

from service.content.service.sheet import (
    MAXIMUM_SPREADSHEET_RANGE_CHARS,
    SpreadsheetInspection,
    SpreadsheetProcessor,
    SpreadsheetProcessorKind,
    SpreadsheetRangeContent,
    SpreadsheetRangeError,
    SpreadsheetRangeTooLarge,
)
from service.content.service.xls import PROCESSOR as XLS_PROCESSOR
from service.content.service.xls import XLS_SUFFIX
from service.content.service.xlsx import PROCESSOR as XLSX_PROCESSOR
from service.content.service.xlsx import XLSX_SUFFIX

CSV_SUFFIX = ".csv"
UTF8_SIGNATURE_ENCODING = "utf-8-sig"
CSV_DELIMITERS = ",;\t|"
CSV_NUMBER_PATTERN = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$")
MAXIMUM_CSV_NUMBER_CHARS = 128
MAXIMUM_CSV_DECIMAL_EXPANSION = 64
CSV_UNSAFE_REASON = "spreadsheet_unsafe_roundtrip"


def _csv_dialect(text: str) -> type[csv.Dialect] | csv.Dialect:
    sample = text[:8192]
    if not sample:
        return csv.excel
    try:
        return csv.Sniffer().sniff(sample, delimiters=CSV_DELIMITERS)
    except csv.Error:
        return csv.excel


def _normalized_decimal(value: str) -> str:
    stripped = value.strip()
    if (
        not stripped
        or len(stripped) > MAXIMUM_CSV_NUMBER_CHARS
        or CSV_NUMBER_PATTERN.fullmatch(stripped) is None
    ):
        return value
    try:
        number = Decimal(stripped)
    except InvalidOperation:
        return value
    if not number.is_finite() or abs(number.adjusted()) > MAXIMUM_CSV_DECIMAL_EXPANSION:
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


def _inspect_csv(payload: bytes) -> SpreadsheetInspection:
    try:
        text = payload.decode(UTF8_SIGNATURE_ENCODING)
        _csv_dialect(text)
    except (UnicodeDecodeError, csv.Error):
        return SpreadsheetInspection(False, CSV_UNSAFE_REASON)
    return SpreadsheetInspection(True)


def decode_csv(payload: bytes) -> str:
    """Decode CSV bytes without crossing into XLS or XLSX implementations."""

    text = payload.decode(UTF8_SIGNATURE_ENCODING)
    rows = csv.reader(StringIO(text), dialect=_csv_dialect(text))
    return "\n".join("\t".join(row) for row in rows)


def _read_csv_range(
    payload: bytes,
    _sheet_name: str,
    selected_range: str,
    max_chars: int,
) -> SpreadsheetRangeContent:
    text = payload.decode(UTF8_SIGNATURE_ENCODING)
    rows = tuple(tuple(row) for row in csv.reader(StringIO(text), dialect=_csv_dialect(text)))
    maximum_column = max((len(row) for row in rows), default=0)
    minimum_column, minimum_row, maximum_column, maximum_row = _range_bounds(
        selected_range,
        maximum_row=len(rows),
        maximum_column=maximum_column,
    )
    selected_rows = (
        (
            _normalized_decimal(row[column - 1]) if column <= len(row) else ""
            for column in range(minimum_column, maximum_column + 1)
        )
        for row in rows[minimum_row - 1 : maximum_row]
    )
    return _render_range(
        selected_rows,
        minimum_column=minimum_column,
        minimum_row=minimum_row,
        maximum_column=maximum_column,
        maximum_row=maximum_row,
        max_chars=max_chars,
    )


CSV_PROCESSOR = SpreadsheetProcessor(
    kind=SpreadsheetProcessorKind.CSV,
    inspect=_inspect_csv,
    preview=None,
    decode=decode_csv,
    read_range=_read_csv_range,
)
PROCESSORS: Mapping[str, SpreadsheetProcessor] = MappingProxyType(
    {
        CSV_SUFFIX: CSV_PROCESSOR,
        XLS_SUFFIX: XLS_PROCESSOR,
        XLSX_SUFFIX: XLSX_PROCESSOR,
    }
)


def processor_for(path: str) -> SpreadsheetProcessor | None:
    """Resolve one format-owned processor without content sniffing."""

    return PROCESSORS.get(Path(path).suffix.lower())


def read_spreadsheet_range(
    path: str,
    payload: bytes,
    sheet_name: str,
    selected_range: str,
    *,
    max_chars: int = MAXIMUM_SPREADSHEET_RANGE_CHARS,
) -> SpreadsheetRangeContent:
    """Dispatch one bounded range to its format-owned processor."""

    if max_chars < 1:
        raise SpreadsheetRangeTooLarge("spreadsheet_range_too_large")
    processor = processor_for(path)
    if processor is None:
        raise SpreadsheetRangeError("unsupported_spreadsheet_suffix")
    try:
        return processor.read_range(payload, sheet_name, selected_range, max_chars)
    except SpreadsheetRangeError:
        raise
    except (KeyError, OSError, TypeError, UnicodeDecodeError, ValueError) as exc:
        raise SpreadsheetRangeError("invalid_spreadsheet_range") from exc


__all__ = [
    "MAXIMUM_SPREADSHEET_RANGE_CHARS",
    "SpreadsheetInspection",
    "SpreadsheetProcessor",
    "SpreadsheetProcessorKind",
    "SpreadsheetRangeContent",
    "SpreadsheetRangeError",
    "SpreadsheetRangeTooLarge",
    "decode_csv",
    "processor_for",
    "read_spreadsheet_range",
]
