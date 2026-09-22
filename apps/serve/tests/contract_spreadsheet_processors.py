"""Contract gate for isolated XLS and XLSX processors."""

from __future__ import annotations

from service.content.service.spreadsheet import (
    SpreadsheetProcessorKind,
    processor_for,
)


def check(name: str, condition: bool, detail: str = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"  ✓ {name}")


def test_xls_and_xlsx_processors_are_owned_by_distinct_modules() -> None:
    xls = processor_for("legacy.xls")
    xlsx = processor_for("modern.xlsx")

    check("XLS processor 已注册", xls is not None)
    check("XLSX processor 已注册", xlsx is not None)
    assert xls is not None
    assert xlsx is not None
    check("XLS processor 身份独立", xls.kind is SpreadsheetProcessorKind.XLS, str(xls.kind))
    check("XLSX processor 身份独立", xlsx.kind is SpreadsheetProcessorKind.XLSX, str(xlsx.kind))
    check(
        "XLS range reader 归 XLS 模块",
        xls.read_range.__module__.endswith(".xls"),
        xls.read_range.__module__,
    )
    check(
        "XLSX range reader 归 XLSX 模块",
        xlsx.read_range.__module__.endswith(".xlsx"),
        xlsx.read_range.__module__,
    )
    check("XLS 不继承 XLSX inspection", xls.inspect is None)
    check("XLSX inspection 归 XLSX 模块", xlsx.inspect is not None)
    assert xlsx.inspect is not None
    check("XLSX preview 归 XLSX 模块", xlsx.preview is not None)
    check("XLSX decode 归 XLSX 模块", xlsx.decode is not None)
    check(
        "XLSX operations 不导入 XLS 实现",
        all(
            operation is None or not operation.__module__.endswith(".xls")
            for operation in (xlsx.inspect, xlsx.preview, xlsx.decode, xlsx.read_range)
        ),
    )


def test_unknown_spreadsheet_processor_fails_closed() -> None:
    check("未知格式不获得 processor", processor_for("unknown.xlsb") is None)


if __name__ == "__main__":
    test_xls_and_xlsx_processors_are_owned_by_distinct_modules()
    test_unknown_spreadsheet_processor_fails_closed()
    print("\n✓ spreadsheet processor contract passed")
