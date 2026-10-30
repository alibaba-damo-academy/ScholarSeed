"""OOXML XLSX processor owned independently from legacy BIFF XLS."""

from __future__ import annotations

import re
from datetime import date, datetime, time
from io import BytesIO
from typing import TYPE_CHECKING, Iterable, cast
from zipfile import BadZipFile, ZipFile

from openpyxl import load_workbook
from openpyxl.utils.cell import get_column_letter, range_boundaries
from openpyxl.utils.exceptions import InvalidFileException

from service.content.service.sheet import (
    SpreadsheetInspection,
    SpreadsheetProcessor,
    SpreadsheetProcessorKind,
    SpreadsheetRangeContent,
    SpreadsheetRangeError,
    SpreadsheetRangeTooLarge,
)

if TYPE_CHECKING:
    from openpyxl.worksheet._read_only import ReadOnlyWorksheet

XLSX_SUFFIX = ".xlsx"
SHEET_HEADING = "[Sheet: {name}]"
COMPLEX_REASON = "spreadsheet_complex_content"
FORMULA_REASON = "spreadsheet_formula_cells"
UNSAFE_REASON = "spreadsheet_unsafe_roundtrip"
COMPLEX_PACKAGE_PREFIXES = (
    "_xmlsignatures/",
    "customxml/",
    "xl/activex/",
    "xl/charts/",
    "xl/ctrlprops/",
    "xl/embeddings/",
    "xl/pivotcache/",
    "xl/pivottables/",
    "xl/querytables/",
    "xl/tables/",
    "xl/externallinks/",
    "xl/connections",
    "xl/drawings/",
    "xl/slicers/",
    "xl/timelines/",
)
COMPLEX_PACKAGE_NAMES = frozenset(("xl/vbaproject.bin",))
REQUIRED_PACKAGE_NAMES = frozenset(("[content_types].xml", "xl/workbook.xml"))
PROTECTION_PATTERN = re.compile(rb"<(?:workbookProtection|sheetProtection)\s+[^>]*>")
FORMULA_MARKER = b"<f"


def _display_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return str(value)


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


def inspect(payload: bytes) -> SpreadsheetInspection:
    """Fail closed when XLSX bytes cannot be safely round-tripped."""

    try:
        with ZipFile(BytesIO(payload)) as archive:
            lowered = {name.lower(): name for name in archive.namelist()}
            if not REQUIRED_PACKAGE_NAMES.issubset(lowered) or not any(
                name.startswith("xl/worksheets/") and name.endswith(".xml") for name in lowered
            ):
                return SpreadsheetInspection(False, UNSAFE_REASON)
            if any(
                name.startswith(COMPLEX_PACKAGE_PREFIXES) or name in COMPLEX_PACKAGE_NAMES
                for name in lowered
            ):
                return SpreadsheetInspection(False, COMPLEX_REASON)
            inspected_names = (
                name
                for name in lowered
                if name == "xl/workbook.xml"
                or (name.startswith("xl/worksheets/") and name.endswith(".xml"))
            )
            formula_found = False
            for lowered_name in inspected_names:
                content = archive.read(lowered[lowered_name])
                if PROTECTION_PATTERN.search(content):
                    return SpreadsheetInspection(False, COMPLEX_REASON)
                if lowered_name.startswith("xl/worksheets/"):
                    formula_found = formula_found or FORMULA_MARKER in content
            if formula_found:
                return SpreadsheetInspection(False, FORMULA_REASON)
    except (BadZipFile, KeyError, OSError):
        return SpreadsheetInspection(False, UNSAFE_REASON)
    return SpreadsheetInspection(True)


def decode(payload: bytes) -> str:
    """Render every populated XLSX worksheet row as structured text."""

    try:
        workbook = load_workbook(BytesIO(payload), read_only=True, data_only=False)
    except (BadZipFile, InvalidFileException, KeyError, OSError, ValueError) as exc:
        raise ValueError("invalid spreadsheet") from exc
    try:
        sheets = []
        for worksheet in workbook.worksheets:
            rows = [
                "\t".join(_display_value(cell.value) for cell in row)
                for row in worksheet.iter_rows()
            ]
            while rows and not rows[-1].rstrip("\t"):
                rows.pop()
            sheets.append("\n".join((SHEET_HEADING.format(name=worksheet.title), *rows)))
        return "\n\n".join(sheets)
    finally:
        workbook.close()


def preview(payload: bytes) -> bytes:
    """Re-emit XLSX bytes for readonly display without changing the source."""

    workbook = None
    try:
        workbook = load_workbook(BytesIO(payload), read_only=False, data_only=False)
        output = BytesIO()
        workbook.save(output)
    except (BadZipFile, InvalidFileException, KeyError, OSError, ValueError) as exc:
        raise ValueError("invalid spreadsheet") from exc
    finally:
        if workbook is not None:
            workbook.close()
    return output.getvalue()


def read_range(
    payload: bytes,
    sheet_name: str,
    selected_range: str,
    max_chars: int,
) -> SpreadsheetRangeContent:
    """Read one range from an OOXML workbook."""

    try:
        workbook = load_workbook(BytesIO(payload), read_only=True, data_only=True)
    except (BadZipFile, InvalidFileException, KeyError, OSError, ValueError) as exc:
        raise SpreadsheetRangeError("invalid_spreadsheet_range") from exc
    try:
        if sheet_name not in workbook.sheetnames:
            raise SpreadsheetRangeError("spreadsheet_sheet_missing")
        sheet = workbook[sheet_name]
        maximum_row: int | None = sheet.max_row
        maximum_column: int | None = sheet.max_column
        if maximum_row is None or maximum_column is None:
            _, _, maximum_column, maximum_row = range_boundaries(
                cast("ReadOnlyWorksheet", sheet).calculate_dimension(force=True)
            )
        assert maximum_row is not None and maximum_column is not None
        minimum_column, minimum_row, maximum_column, maximum_row = _range_bounds(
            selected_range,
            maximum_row=maximum_row,
            maximum_column=maximum_column,
        )
        rows = (
            (_display_value(cell.value) for cell in row)
            for row in sheet.iter_rows(
                min_row=minimum_row,
                max_row=maximum_row,
                min_col=minimum_column,
                max_col=maximum_column,
            )
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
        workbook.close()


PROCESSOR = SpreadsheetProcessor(
    kind=SpreadsheetProcessorKind.XLSX,
    inspect=inspect,
    preview=preview,
    decode=decode,
    read_range=read_range,
)


__all__ = ["PROCESSOR", "XLSX_SUFFIX", "decode", "inspect", "preview", "read_range"]
