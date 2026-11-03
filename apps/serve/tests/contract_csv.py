"""Native CSV admission and source-string selection contracts."""

import csv
import os
from io import StringIO
from pathlib import Path

from service.content.service.sheet import SpreadsheetRangeError as RangeError
from service.content.service.sheet import SpreadsheetRangeTooLarge as RangeLarge
from service.content.service.spreadsheet import _inspect_csv as inspect_csv
from service.content.service.spreadsheet import _read_csv_range as read_range


def assert_raises(kind, callback):
    try:
        callback()
    except kind:
        return
    raise AssertionError(f"{kind.__name__} not raised")


def test_strings_quotes_bom_dialect():
    raw = '\ufeffid;value;note\r\n001;1e3;"x\r\ny"\r\n002;"a;""b"""\r\n'.encode()
    assert inspect_csv(raw).editable
    result = read_range(raw, "Sheet1", "A2:C3", 100)
    assert result.text == '001\t1e3\tx\r\ny\n002\ta;"b"\t'
    assert result.selected_range == "A2:C3"


def test_strict_admission():
    for payload in (b"\xff", b'a,"unterminated', b'a,"closed"junk\n', b'a"quote,b\n'):
        assert not inspect_csv(payload).editable
        assert_raises(
            RangeError, lambda payload=payload: read_range(payload, "Sheet1", "A1:B1", 100)
        )
    assert inspect_csv(b"").editable
    assert inspect_csv(b'a,"a,""b"""\n').editable


def test_bounds_stream_budget_and_crop():
    payload = b"id,value\n001,1e3\n,,\n"
    assert read_range(payload, "Sheet1", "A2:C3", 100).text == "001\t1e3"
    assert read_range(payload, "Sheet1", "A2:C3", 100).selected_range == "A2:B2"
    assert_raises(RangeError, lambda: read_range(payload, "Sheet1", "A99:B100", 100))
    assert_raises(RangeLarge, lambda: read_range(payload, "Sheet1", "A1:B2", 3))
    assert read_range(payload, "Sheet1", "A:B", 100).selected_range == "A1:B2"


def test_original_corpus():
    root = Path(os.environ["SCHOLARSEED_OFFICE_CORPUS"]) / "csv"
    for path in sorted(root.glob("*.csv")):
        raw = path.read_bytes()
        assert inspect_csv(raw).editable, path.name
        delimiter = ";" if "semicolon" in path.name else ","
        rows = list(
            csv.reader(
                StringIO(raw.decode("utf-8-sig"), newline=""), delimiter=delimiter, strict=True
            )
        )
        result = read_range(raw, "Sheet1", "A1:B2", 1000)
        assert result.text == "\n".join("\t".join(row[:2]) for row in rows[:2]), path.name


if __name__ == "__main__":
    for function in (
        test_strings_quotes_bom_dialect,
        test_strict_admission,
        test_bounds_stream_budget_and_crop,
    ):
        function()
        print("PASS", function.__name__)

    if os.environ.get("SCHOLARSEED_OFFICE_CORPUS"):
        test_original_corpus()
        print("PASS test_original_corpus")
