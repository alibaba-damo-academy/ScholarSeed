"""Shared spreadsheet contracts and bounded range rendering primitives."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable

MAXIMUM_SPREADSHEET_RANGE_CHARS = 40_000


@dataclass(frozen=True)
class SpreadsheetInspection:
    """Whether bytes can be safely offered to the lightweight editor."""

    editable: bool
    reason: str | None = None


@dataclass(frozen=True)
class SpreadsheetRangeContent:
    """Resolved, bounded worksheet cells rendered as tabular plain text."""

    text: str
    selected_range: str


class SpreadsheetRangeError(ValueError):
    """The requested workbook, sheet, or cell range cannot be resolved."""


class SpreadsheetRangeTooLarge(SpreadsheetRangeError):
    """The selected cells exceed the safe model-context character budget."""


class SpreadsheetProcessorKind(str, Enum):
    """Stable processor identity exposed across the Workbench boundary."""

    CSV = "csv"
    XLS = "xls"
    XLSX = "xlsx"


SpreadsheetInspector = Callable[[bytes], SpreadsheetInspection]
SpreadsheetPreviewer = Callable[[bytes], bytes]
SpreadsheetDecoder = Callable[[bytes], str]
SpreadsheetRangeReader = Callable[[bytes, str, str, int], SpreadsheetRangeContent]


@dataclass(frozen=True)
class SpreadsheetProcessor:
    """Operations owned by one spreadsheet format implementation."""

    kind: SpreadsheetProcessorKind
    inspect: SpreadsheetInspector | None
    preview: SpreadsheetPreviewer | None
    decode: SpreadsheetDecoder | None
    read_range: SpreadsheetRangeReader


__all__ = [
    "MAXIMUM_SPREADSHEET_RANGE_CHARS",
    "SpreadsheetInspection",
    "SpreadsheetProcessor",
    "SpreadsheetProcessorKind",
    "SpreadsheetRangeContent",
    "SpreadsheetRangeError",
    "SpreadsheetRangeTooLarge",
]
