"""Spreadsheet processor registry and CSV implementation owned by Content."""

from __future__ import annotations

import csv
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
CSV_DIALECT_SAMPLE_CHARS = 65_536
CSV_DIALECT_SAMPLE_RECORDS = 32
CSV_UNSAFE_REASON = "spreadsheet_unsafe_roundtrip"


def _csv_delimiter(text: str) -> str:
    """Same quote-aware, record-consistency score as the Desktop CSV byte index."""
    sample = (
        text[:CSV_DIALECT_SAMPLE_CHARS]
        .encode("utf-8")[:CSV_DIALECT_SAMPLE_CHARS]
        .decode("utf-8", errors="ignore")
    )
    selected, best = ",", 0.0
    for delimiter in CSV_DELIMITERS:
        counts: list[int] = []
        record_start = field_start = 0
        width = 1
        quoted = False
        at = 0
        while at < len(sample):
            char = sample[at]
            if quoted:
                if char == '"':
                    if at + 1 < len(sample) and sample[at + 1] == '"':
                        at += 1
                    else:
                        quoted = False
            elif char == delimiter:
                width += 1
                field_start = at + 1
            elif char in "\r\n":
                if char == "\r" and at + 1 < len(sample) and sample[at + 1] == "\n":
                    at += 1
                counts.append(width)
                record_start = field_start = at + 1
                width = 1
                if len(counts) >= CSV_DIALECT_SAMPLE_RECORDS:
                    break
            elif char == '"' and at == field_start:
                quoted = True
            at += 1
        if (
            at >= len(sample)
            and len(sample) == len(text)
            and record_start < len(sample)
            and not quoted
        ):
            counts.append(width)
        frequencies: dict[int, int] = {}
        for width in counts:
            if width > 1:
                frequencies[width] = frequencies.get(width, 0) + 1
        for width, frequency in frequencies.items():
            score = frequency * frequency / max(len(counts), 1) * width
            if score > best:
                selected, best = delimiter, score
    return selected


def _csv_dialect(text: str) -> csv.Dialect:
    delimiter = _csv_delimiter(text)

    class Dialect(csv.excel):
        strict = True

    Dialect.delimiter = delimiter
    return Dialect()


def _validate_csv(text: str, delimiter: str) -> None:
    """Reject syntax which cannot round-trip through the source-string editor."""
    quoted = closed = False
    field_start = 0
    at = 0
    while at < len(text):
        char = text[at]
        if quoted:
            if char == '"':
                if at + 1 < len(text) and text[at + 1] == '"':
                    at += 1
                else:
                    quoted, closed = False, True
        elif char == delimiter:
            field_start, closed = at + 1, False
        elif char in "\r\n":
            if char == "\r" and at + 1 < len(text) and text[at + 1] == "\n":
                at += 1
            field_start, closed = at + 1, False
        elif closed or (char == '"' and at != field_start):
            raise csv.Error("csv_quotes_invalid")
        elif char == '"':
            quoted = True
        at += 1
    if quoted:
        raise csv.Error("csv_quotes_invalid")


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
        _validate_csv(text, _csv_dialect(text).delimiter)
    except (UnicodeDecodeError, csv.Error):
        return SpreadsheetInspection(False, CSV_UNSAFE_REASON)
    return SpreadsheetInspection(True)


def decode_csv(payload: bytes) -> str:
    """Decode CSV bytes without crossing into XLS or XLSX implementations."""

    text = payload.decode(UTF8_SIGNATURE_ENCODING)
    dialect = _csv_dialect(text)
    _validate_csv(text, dialect.delimiter)
    rows = csv.reader(StringIO(text, newline=""), dialect=dialect)
    return "\n".join("\t".join(row) for row in rows)


def _read_csv_range(
    payload: bytes,
    _sheet_name: str,
    selected_range: str,
    max_chars: int,
) -> SpreadsheetRangeContent:
    try:
        text = payload.decode(UTF8_SIGNATURE_ENCODING)
        dialect = _csv_dialect(text)
        _validate_csv(text, dialect.delimiter)
        minimum_column, minimum_row, requested_column, requested_row = range_boundaries(
            selected_range
        )
        minimum_column = minimum_column or 1
        minimum_row = minimum_row or 1
        maximum_column = requested_column or 0
        maximum_row = 0
        selected_rows: list[tuple[str, ...]] = []
        characters = 0
        for row_number, row in enumerate(
            csv.reader(StringIO(text, newline=""), dialect=dialect), 1
        ):
            maximum_row = row_number
            if row_number < minimum_row:
                continue
            if requested_row is not None and row_number > requested_row:
                maximum_row = requested_row
                break
            cells = tuple(row[minimum_column - 1 : requested_column])
            if requested_column is None:
                maximum_column = max(maximum_column, len(row))
            characters += (
                sum(len(cell) for cell in cells) + max(len(cells) - 1, 0) + bool(selected_rows)
            )
            if characters > max_chars:
                raise SpreadsheetRangeTooLarge("spreadsheet_range_too_large")
            selected_rows.append(cells)
        if maximum_row < minimum_row or maximum_column < minimum_column or not selected_rows:
            raise SpreadsheetRangeError("empty_spreadsheet_range")
        # Missing fields in ragged records retain the existing TSV rectangular contract.
        width = maximum_column - minimum_column + 1
        rectangular = (row + ("",) * max(0, width - len(row)) for row in selected_rows)
        return _render_range(
            rectangular,
            minimum_column=minimum_column,
            minimum_row=minimum_row,
            maximum_column=maximum_column,
            maximum_row=maximum_row,
            max_chars=max_chars,
        )
    except (UnicodeDecodeError, csv.Error, ValueError) as exc:
        if isinstance(exc, SpreadsheetRangeError):
            raise
        raise SpreadsheetRangeError("invalid_spreadsheet_range") from exc


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
