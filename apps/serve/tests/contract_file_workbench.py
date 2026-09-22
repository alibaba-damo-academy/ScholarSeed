"""统一文件工作台的打开、范围读取与 CAS 保存契约门。

这些测试覆盖文件工作台最危险的不变量：打开必须绑定真实 revision，保存必须
携带该 revision，外部修改后旧 revision 不能覆盖文件。测试走真实 FastAPI 路由
和临时目录中的真实文件，不以组件状态或 mock store 代替磁盘结果。
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from PIL import Image

from service.content.domain.model import PREPARED_CONFLICT, ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import MAX_BYTES, ContentService, ProjectRegistry
from service.platform.web import register_cross_origin_isolation
from service.resources.api.versions import register_version_routes
from service.resources.service.history import ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.workbench.api.routes import register_workbench_routes
from service.workbench.domain.model import WORKBENCH_PREVIEW_MAX_BYTES, WorkbenchFormatPolicy
from service.workbench.persistence.records import PdfRecordCatalog
from service.workbench.service.records import PdfRecordStore

PASS = 0
FAIL = 0
MEBIBYTE = 1024 * 1024
LEGACY_EDITOR_MAX_BYTES = 64 * MEBIBYTE


class WorkbenchSettings:
    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def _client(project: Path) -> TestClient:
    app = FastAPI()
    app.state.workspace = str(project)
    catalog = ContentCatalog(project.parent / f"{project.name}-content.sqlite3")
    registry = ProjectRegistry(str(project), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog)
    settings = WorkbenchSettings()
    records = PdfRecordStore(content, PdfRecordCatalog(content))
    app.state.content = content
    app.state.pdf_records = records
    app.state.resource_versions = ResourceVersionService(
        content,
        ResourceRetentionService(content, settings),
        WorkbenchFormatPolicy(),
        records,
    )
    app.state.resource_version_supervisor = ResourceVersionSupervisor(
        content, app.state.resource_versions, WorkbenchFormatPolicy(), settings
    )
    app.state.resource_versions.bind_admission_policy(app.state.resource_version_supervisor)
    register_version_routes(app)
    register_cross_origin_isolation(app)
    register_workbench_routes(app)
    return TestClient(app)


def test_manual_raw_versioning_does_not_invent_preview_capabilities() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-manual-version-"))
    try:
        payload = b"opaque\x00\xff\n"
        (project / "sample.custom").write_bytes(payload)
        client = _client(project)
        params = {"path": "sample.custom"}
        before = client.get("/api/workbench/open", params=params).json()
        check(
            "raw file starts outside default whitelist", not before["capabilities"]["can_version"]
        )
        joined = client.post(
            "/api/serve/resources/version-admission",
            params={"project": before["project_id"]},
            json={"path": "sample.custom", "expected_disk_revision": before["revision"]},
            headers={"Idempotency-Key": "join-raw-file"},
        )
        check(
            "manual raw file admission through public API", joined.status_code == 200, joined.text
        )
        after = client.get("/api/workbench/open", params=params).json()
        check("manual raw file gains versioning", after["capabilities"]["can_version"], str(after))
        check(
            "manual raw versioning does not invent preview or diff",
            not after["capabilities"]["can_preview"] and not after["capabilities"]["can_diff"],
            str(after),
        )
        history = client.app.state.resource_versions.history(before["project_id"], "sample.custom")
        check("manual initial version retains exact raw bytes", bool(history))
        if history:
            content, _ = client.app.state.resource_versions.read(
                before["project_id"], history[0].id
            )
            check("manual initial version raw bytes match", content == payload)
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_open_binds_existing_snapshot() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-open-"))
    try:
        target = project / "notes.txt"
        target.write_bytes(b"alpha\nbeta\n")
        client = _client(project)

        opened = client.get("/api/workbench/open", params={"path": "notes.txt"})
        payload = opened.json()
        revision = payload.get("revision", "")
        check(
            "open 返回真实文件 snapshot",
            opened.status_code == 200
            and payload.get("path") == "notes.txt"
            and payload.get("size") == target.stat().st_size
            and payload.get("media_type") == "text/plain"
            and revision.startswith("sha256:"),
            f"status={opened.status_code} body={opened.text}",
        )
        check(
            "Workbench 页面链路启用跨源隔离",
            opened.headers.get("cross-origin-opener-policy") == "same-origin"
            and opened.headers.get("cross-origin-embedder-policy") == "require-corp",
            str(dict(opened.headers)),
        )

        missing = client.get("/api/workbench/open", params={"path": "missing.txt"})
        check(
            "open 不存在文件返回 404",
            missing.status_code == 404 and missing.json().get("detail") == "file_not_found",
            f"status={missing.status_code} body={missing.text}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_open_projects_versioning_without_a_resource_tree_scan() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-versioning-projection-"))
    try:
        target = project / "resources" / "notes.md"
        target.parent.mkdir()
        target.write_text("# notes\n", encoding="utf-8")
        client = _client(project)
        content = client.app.state.content
        versions = client.app.state.resource_versions
        project_id = content.project().id
        versions.ensure_initial(project_id, "resources/notes.md")

        with (
            patch.object(content, "scan_resources", wraps=content.scan_resources) as scan_resources,
            patch.object(versions, "observe", wraps=versions.observe) as observe,
        ):
            opened = client.get(
                "/api/workbench/open",
                params={"project": project_id, "path": "resources/notes.md"},
            )

        payload = opened.json()
        versioning = payload.get("versioning", {})
        check(
            "open 直接返回完整版本能力",
            opened.status_code == 200
            and versioning.get("file_id")
            and versioning.get("disk_revision") == payload.get("revision")
            and versioning.get("management_state") == "managed",
            f"status={opened.status_code} body={opened.text}",
        )
        check(
            "单文件打开不扫描完整资源树",
            scan_resources.call_count == 0,
            f"calls={scan_resources.call_count}",
        )
        check(
            "单文件打开只执行一次版本观测",
            observe.call_count == 1,
            f"calls={observe.call_count}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_recreated_pdf_opens_with_an_isolated_identity() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-recreated-pdf-"))
    try:
        target = project / "paper.pdf"
        original = b"%PDF-1.4\nsame bytes\n"
        target.write_bytes(original)
        client = _client(project)

        first = client.get("/api/workbench/open", params={"path": target.name})
        first_asset_id = first.json().get("asset_id", "")
        initialized = client.get(f"/api/workbench/assets/{first_asset_id}/pdf/records")
        replacement = project / "replacement.tmp"
        replacement.write_bytes(original)
        replacement.replace(target)
        reopened = client.get("/api/workbench/open", params={"path": target.name})
        reopened_asset_id = reopened.json().get("asset_id", "")

        check(
            "同路径重建 PDF 正常打开且不继承旧 identity",
            first.status_code == 200
            and initialized.status_code == 200
            and reopened.status_code == 200
            and bool(first_asset_id)
            and bool(reopened_asset_id)
            and reopened_asset_id != first_asset_id,
            f"first={first.text} reopened={reopened.text}",
        )
        old_records = client.get(f"/api/workbench/assets/{first_asset_id}/pdf/records")
        new_records = client.get(f"/api/workbench/assets/{reopened_asset_id}/pdf/records")
        check(
            "重建 PDF 的新旧记录归属保持隔离",
            old_records.status_code == 200
            and old_records.json().get("source_state") == "conflict"
            and new_records.status_code == 200
            and new_records.json().get("source_state") == "available",
            f"old={old_records.text} new={new_records.text}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_pdf_identity_conflict_is_a_structured_response() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-pdf-conflict-"))
    try:
        target = project / "paper.pdf"
        target.write_bytes(b"%PDF-1.4\nconflict\n")
        client = _client(project)
        with patch.object(
            client.app.state.content,
            "identify",
            side_effect=ContentError(PREPARED_CONFLICT),
        ):
            response = client.get("/api/workbench/open", params={"path": target.name})
        check(
            "PDF identity 冲突返回结构化 409 而不是未处理异常",
            response.status_code == 409 and response.json().get("detail") == PREPARED_CONFLICT,
            f"status={response.status_code} body={response.text}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_unknown_files_are_classified_by_content_for_basic_preview() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-content-kind-"))
    try:
        (project / "Dockerfile").write_text("FROM python:3.13\n", encoding="utf-8")
        (project / "opaque.bin").write_bytes(b"prefix\x00suffix")
        (project / "invalid.data").write_bytes(b"\xff\xfe\xfd")
        (project / "misleading.txt").write_bytes(b"prefix\x00suffix")
        oversized = project / "oversized"
        with oversized.open("wb") as stream:
            stream.truncate(WORKBENCH_PREVIEW_MAX_BYTES + 1)
        client = _client(project)

        text = client.get("/api/workbench/open", params={"path": "Dockerfile"})
        binary = client.get("/api/workbench/open", params={"path": "opaque.bin"})
        invalid = client.get("/api/workbench/open", params={"path": "invalid.data"})
        misleading = client.get("/api/workbench/open", params={"path": "misleading.txt"})
        large = client.get("/api/workbench/open", params={"path": "oversized"})

        text_payload = text.json()
        check(
            "无扩展名 UTF-8 文件进入基础代码编辑器",
            text.status_code == 200
            and text_payload.get("content_kind") == "text"
            and text_payload.get("viewer") == "code"
            and text_payload.get("capabilities", {}).get("can_preview") is True
            and text_payload.get("capabilities", {}).get("can_edit") is True
            and text_payload.get("capabilities", {}).get("can_save") is True
            and text_payload.get("capabilities", {}).get("can_version") is False,
            text.text,
        )
        edited_content = b"FROM python:3.13-slim\n"
        saved = client.put(
            "/api/workbench/content",
            params={"path": "Dockerfile"},
            headers={
                "Content-Type": "application/octet-stream",
                "If-Match": f'"{text_payload.get("revision", "")}"',
            },
            content=edited_content,
        )
        check(
            "无扩展名文本可通过工作台保存",
            saved.status_code == 204 and (project / "Dockerfile").read_bytes() == edited_content,
            f"status={saved.status_code} body={saved.text}",
        )
        for label, response in (
            ("NUL 文件", binary),
            ("非法 UTF-8 文件", invalid),
            ("伪装成 TXT 的二进制文件", misleading),
        ):
            payload = response.json()
            check(
                f"{label}明确归类为二进制",
                response.status_code == 200
                and payload.get("content_kind") == "binary"
                and payload.get("viewer") == "unsupported"
                and payload.get("capabilities", {}).get("can_preview") is False,
                response.text,
            )
        large_payload = large.json()
        check(
            "超限未知文件返回可辨识占位而非读取失败",
            large.status_code == 200
            and large_payload.get("content_kind") == "oversized"
            and large_payload.get("viewer") == "unsupported"
            and large_payload.get("capabilities", {}).get("pending") == ["file_too_large"],
            large.text,
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_large_editor_commit_crosses_old_64mib_ceiling() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-large-save-"))
    try:
        target = project / "large.c"
        target.write_bytes(b"x")
        client = _client(project)
        opened = client.get("/api/workbench/open", params={"path": target.name}).json()
        content = b"x" * (LEGACY_EDITOR_MAX_BYTES + 1)
        saved = client.put(
            "/api/workbench/content",
            params={"path": target.name},
            content=content,
            headers={
                "Content-Type": "application/octet-stream",
                "If-Match": f'"{opened.get("revision", "")}"',
            },
        )
        check(
            "64MiB 文件增加内容后仍可原子保存",
            MAX_BYTES > len(content)
            and saved.status_code == 204
            and target.stat().st_size == len(content),
            f"limit={MAX_BYTES} save={saved.status_code} size={target.stat().st_size}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_registered_preview_crosses_content_default_and_stops_at_500_mib() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-preview-limit-"))
    try:
        previewable = project / "large.pdf"
        previewable.write_bytes(b"%PDF-1.7\n")
        with previewable.open("r+b") as stream:
            stream.truncate(MAX_BYTES + 1)
        oversized = project / "oversized.pdf"
        oversized.write_bytes(b"%PDF-1.7\n")
        with oversized.open("r+b") as stream:
            stream.truncate(WORKBENCH_PREVIEW_MAX_BYTES + 1)
        client = _client(project)

        opened = client.get("/api/workbench/open", params={"path": previewable.name})
        opened_payload = opened.json()
        check(
            "超过内容默认上限的已注册文件仍可进入预览",
            opened.status_code == 200
            and opened_payload.get("viewer") == "pdf"
            and opened_payload.get("content_kind") == "binary"
            and opened_payload.get("capabilities", {}).get("can_preview") is True,
            opened.text,
        )
        ranged = client.get(
            "/api/workbench/content",
            params={"path": previewable.name},
            headers={"Range": "bytes=0-8"},
        )
        check(
            "大文件预览通道继续按 Range 返回",
            ranged.status_code == 206 and ranged.content == b"%PDF-1.7\n",
            f"status={ranged.status_code} body={ranged.content!r}",
        )
        with patch.object(
            client.app.state.content,
            "read_bytes",
            return_value=(b"%PDF-1.7\n", "application/pdf"),
        ) as read_bytes:
            complete = client.get("/api/workbench/content", params={"path": previewable.name})
        check(
            "完整预览读取使用 500 MiB 独立上限",
            complete.status_code == 200
            and complete.content == b"%PDF-1.7\n"
            and read_bytes.call_args.kwargs.get("max_bytes") == WORKBENCH_PREVIEW_MAX_BYTES,
            f"status={complete.status_code} call={read_bytes.call_args}",
        )
        asset_id = opened_payload.get("asset_id", "")
        records = client.get(f"/api/workbench/assets/{asset_id}/pdf/records")
        check(
            "大 PDF 的批注记录随预览使用同一 500 MiB 上限",
            records.status_code == 200
            and records.json().get("records")
            == {"schema_version": 1, "marks": [], "comments": [], "notes": []},
            f"status={records.status_code} body={records.text}",
        )
        rejected = client.get("/api/workbench/open", params={"path": oversized.name})
        rejected_payload = rejected.json()
        check(
            "超过 500 MiB 的文件仍明确拒绝内置预览",
            rejected.status_code == 200
            and rejected_payload.get("viewer") == "unsupported"
            and rejected_payload.get("content_kind") == "oversized"
            and rejected_payload.get("capabilities", {}).get("pending") == ["file_too_large"],
            rejected.text,
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def _workbook_bytes(*, chart: bool = False, formula: bool = False) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Results"
    sheet.append(("sample", "value"))
    sheet.append(("alpha", 7))
    if formula:
        sheet["C2"] = "=B2*2"
    if chart:
        chart_value = BarChart()
        chart_value.add_data(
            Reference(sheet, min_col=2, min_row=1, max_row=2), titles_from_data=True
        )
        sheet.add_chart(chart_value, "D2")
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def _workbook_with_file_version() -> bytes:
    source = BytesIO(_workbook_bytes())
    output = BytesIO()
    with ZipFile(source) as incoming, ZipFile(output, "w", ZIP_DEFLATED) as outgoing:
        for info in incoming.infolist():
            content = incoming.read(info.filename)
            if info.filename == "xl/workbook.xml":
                content = content.replace(b"<workbookPr", b"<fileVersion/><workbookPr", 1)
            outgoing.writestr(info, content)
    return output.getvalue()


def _invalid_workbook_bytes() -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("placeholder.txt", "not a workbook")
    return output.getvalue()


def test_spreadsheets_share_zeta_viewer_and_fail_closed_for_complex_xlsx() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-spreadsheet-"))
    try:
        (project / "results.csv").write_text("sample,value\nalpha,7\n", encoding="utf-8")
        (project / "single.csv").write_text("value\n", encoding="utf-8")
        (project / "simple.xlsx").write_bytes(_workbook_bytes())
        (project / "versioned.xlsx").write_bytes(_workbook_with_file_version())
        (project / "chart.xlsx").write_bytes(_workbook_bytes(chart=True))
        (project / "formula.xlsx").write_bytes(_workbook_bytes(formula=True))
        (project / "invalid.xlsx").write_bytes(_invalid_workbook_bytes())
        client = _client(project)
        chart_source = (project / "chart.xlsx").read_bytes()

        csv_open = client.get("/api/workbench/open", params={"path": "results.csv"}).json()
        single_open = client.get("/api/workbench/open", params={"path": "single.csv"}).json()
        simple_open = client.get("/api/workbench/open", params={"path": "simple.xlsx"}).json()
        versioned_open = client.get("/api/workbench/open", params={"path": "versioned.xlsx"}).json()
        chart_open = client.get("/api/workbench/open", params={"path": "chart.xlsx"}).json()
        formula_open = client.get("/api/workbench/open", params={"path": "formula.xlsx"}).json()
        invalid_open = client.get("/api/workbench/open", params={"path": "invalid.xlsx"}).json()
        chart_preview = client.get(
            "/api/workbench/content", params={"path": "chart.xlsx", "preview": "true"}
        )
        simple_preview = client.get(
            "/api/workbench/content", params={"path": "simple.xlsx", "preview": "true"}
        )

        check(
            "CSV 与 XLSX 统一进入 ZetaOffice spreadsheet viewer",
            csv_open.get("viewer") == "spreadsheet" and simple_open.get("viewer") == "spreadsheet",
            f"csv={csv_open} simple={simple_open}",
        )
        check(
            "CSV 与 XLSX 保留独立 processor 身份",
            csv_open.get("processor") == "csv" and simple_open.get("processor") == "xlsx",
            f"csv={csv_open} simple={simple_open}",
        )
        check(
            "CSV 与 XLSX 统一只读",
            csv_open.get("capabilities", {}).get("can_edit") is False
            and single_open.get("capabilities", {}).get("can_edit") is False
            and csv_open.get("capabilities", {}).get("can_save") is False
            and csv_open.get("capabilities", {}).get("can_version") is True
            and simple_open.get("capabilities", {}).get("can_edit") is False
            and simple_open.get("capabilities", {}).get("can_save") is False
            and simple_open.get("capabilities", {}).get("can_version") is True,
            f"csv={csv_open} single={single_open} simple={simple_open}",
        )
        check(
            "XLSX 元数据中的 fileVersion 不会产生复杂内容告警",
            versioned_open.get("capabilities", {}).get("can_edit") is False
            and versioned_open.get("capabilities", {}).get("pending") == [],
            str(versioned_open),
        )
        check(
            "包含图表的复杂 XLSX fail closed 为只读",
            chart_open.get("viewer") == "spreadsheet"
            and chart_open.get("capabilities", {}).get("can_edit") is False
            and chart_open.get("capabilities", {}).get("can_save") is False
            and "spreadsheet_complex_content"
            in chart_open.get("capabilities", {}).get("pending", []),
            str(chart_open),
        )
        preview_workbook = load_workbook(BytesIO(chart_preview.content), read_only=True)
        try:
            preview_sheets = preview_workbook.sheetnames
        finally:
            preview_workbook.close()
        check(
            "只读 XLSX 返回兼容预览且不改写原文件",
            chart_preview.status_code == 200
            and preview_sheets == ["Results"]
            and (project / "chart.xlsx").read_bytes() == chart_source,
            f"status={chart_preview.status_code}",
        )
        check(
            "安全 XLSX 只读预览保持原始字节",
            simple_preview.status_code == 200
            and simple_preview.content == (project / "simple.xlsx").read_bytes(),
            f"status={simple_preview.status_code}",
        )
        check(
            "含公式的 XLSX 在公式单元格保护落地前 fail closed 为只读",
            formula_open.get("capabilities", {}).get("can_edit") is False
            and formula_open.get("capabilities", {}).get("can_save") is False
            and "spreadsheet_formula_cells"
            in formula_open.get("capabilities", {}).get("pending", []),
            str(formula_open),
        )
        check(
            "结构不完整的 XLSX fail closed 为只读",
            invalid_open.get("capabilities", {}).get("can_edit") is False
            and "spreadsheet_unsafe_roundtrip"
            in invalid_open.get("capabilities", {}).get("pending", []),
            str(invalid_open),
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_office_documents_are_preview_only() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-office-readonly-"))
    try:
        names = ("document.doc", "document.docx", "workbook.xls", "slides.ppt", "slides.pptx")
        for name in names:
            (project / name).write_bytes(b"office-content")
        client = _client(project)
        for name in names:
            opened = client.get("/api/workbench/open", params={"path": name})
            payload = opened.json()
            capabilities = payload.get("capabilities", {})
            check(
                f"{name} 仅提供可选择的版本化预览",
                opened.status_code == 200
                and payload.get("viewer") == "office"
                and payload.get("processor") == ("xls" if name.endswith(".xls") else None)
                and capabilities.get("can_preview") is True
                and capabilities.get("can_select") is True
                and capabilities.get("can_version") is True
                and capabilities.get("can_edit") is False
                and capabilities.get("can_save") is False,
                opened.text,
            )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_head_and_range_use_same_revision() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-range-"))
    try:
        content = b"0123456789"
        (project / "data.bin").write_bytes(content)
        client = _client(project)

        head = client.head("/api/workbench/content", params={"path": "data.bin"})
        etag = head.headers.get("etag", "")
        check(
            "HEAD 返回长度与强 ETag",
            head.status_code == 200
            and head.content == b""
            and head.headers.get("content-length") == str(len(content))
            and etag.startswith('"sha256:'),
            f"status={head.status_code} headers={dict(head.headers)}",
        )

        partial = client.get(
            "/api/workbench/content",
            params={"path": "data.bin"},
            headers={"Range": "bytes=2-5"},
        )
        check(
            "Range 返回 206 和精确字节",
            partial.status_code == 206
            and partial.content == b"2345"
            and partial.headers.get("content-range") == "bytes 2-5/10"
            and partial.headers.get("etag") == etag,
            f"status={partial.status_code} body={partial.content!r} headers={dict(partial.headers)}",
        )

        invalid = client.get(
            "/api/workbench/content",
            params={"path": "data.bin"},
            headers={"Range": "bytes=20-30"},
        )
        check(
            "越界 Range 返回 416",
            invalid.status_code == 416 and invalid.headers.get("content-range") == "bytes */10",
            f"status={invalid.status_code} headers={dict(invalid.headers)}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_commit_requires_current_revision() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-commit-"))
    try:
        target = project / "draft.md"
        target.write_bytes(b"before\n")
        os.chmod(target, 0o640)
        client = _client(project)

        head = client.head("/api/workbench/content", params={"path": "draft.md"})
        etag = head.headers["etag"]

        missing = client.put(
            "/api/workbench/content",
            params={"path": "draft.md"},
            content=b"unsafe\n",
            headers={"Content-Type": "application/octet-stream"},
        )
        check(
            "缺 If-Match 返回 428 且不写盘",
            missing.status_code == 428 and target.read_bytes() == b"before\n",
            f"status={missing.status_code} body={missing.text}",
        )

        saved = client.put(
            "/api/workbench/content",
            params={"path": "draft.md"},
            content=b"saved\n",
            headers={
                "Content-Type": "application/octet-stream",
                "If-Match": etag,
                "Idempotency-Key": "save-draft-once",
            },
        )
        next_etag = saved.headers.get("etag", "")
        project_id = client.get("/api/workbench/open", params={"path": "draft.md"}).json()[
            "project_id"
        ]
        versions = client.app.state.resource_versions.history(project_id, "draft.md")
        check(
            "匹配 revision 原子保存并返回新 ETag",
            saved.status_code == 204
            and target.read_bytes() == b"saved\n"
            and next_etag
            and next_etag != etag,
            f"status={saved.status_code} headers={dict(saved.headers)}",
        )
        check(
            "编辑器保存文件时同步封存版本",
            [item.sequence for item in versions] == [2, 1]
            and client.app.state.resource_versions.capability(
                project_id, "draft.md"
            ).snapshot_state.value
            == "saved",
            repr(versions),
        )
        check(
            "保存保留原文件 mode",
            stat.S_IMODE(target.stat().st_mode) == 0o640,
            oct(stat.S_IMODE(target.stat().st_mode)),
        )
        retried = client.put(
            "/api/workbench/content",
            params={"path": "draft.md"},
            content=b"saved\n",
            headers={
                "Content-Type": "application/octet-stream",
                "If-Match": etag,
                "Idempotency-Key": "save-draft-once",
            },
        )
        check(
            "相同保存请求重放幂等返回同一磁盘结果",
            retried.status_code == 204
            and retried.headers.get("etag") == next_etag
            and target.read_bytes() == b"saved\n"
            and len(client.app.state.resource_versions.history(project_id, "draft.md")) == 2,
            f"status={retried.status_code} body={retried.text}",
        )
        mismatched = client.put(
            "/api/workbench/content",
            params={"path": "draft.md"},
            content=b"different payload\n",
            headers={
                "Content-Type": "application/octet-stream",
                "If-Match": etag,
                "Idempotency-Key": "save-draft-once",
            },
        )
        check(
            "相同幂等键拒绝不同保存内容",
            mismatched.status_code == 400
            and mismatched.json().get("detail") == "idempotency_conflict"
            and target.read_bytes() == b"saved\n",
            f"status={mismatched.status_code} body={mismatched.text}",
        )

        target.write_bytes(b"external\n")
        conflict = client.put(
            "/api/workbench/content",
            params={"path": "draft.md"},
            content=b"stale overwrite\n",
            headers={"Content-Type": "application/octet-stream", "If-Match": next_etag},
        )
        check(
            "外部修改后旧 revision 返回 412 且不覆盖",
            conflict.status_code == 412
            and conflict.json().get("detail") == "revision_conflict"
            and target.read_bytes() == b"external\n",
            f"status={conflict.status_code} body={conflict.text}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_pdf_records_are_database_only_and_revision_safe() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-annotations-"))
    try:
        target = project / "paper.pdf"
        original = b"%PDF-1.4\nimmutable\n"
        target.write_bytes(original)
        client = _client(project)

        descriptor = client.get("/api/workbench/open", params={"path": "paper.pdf"}).json()
        asset_id = descriptor.get("asset_id", "")
        records_route = f"/api/workbench/assets/{asset_id}/pdf/records"
        opened = client.get(records_route)
        revision = opened.json().get("record_revision", "")
        source_revision = opened.json().get("source_revision", "")
        check(
            "PDF 初次打开分配稳定 asset_id 并返回空记录",
            opened.status_code == 200
            and bool(asset_id)
            and revision.startswith("sha256:")
            and opened.json().get("record_target", {}).get("subject_id") == asset_id
            and opened.json().get("records")
            == {"schema_version": 1, "marks": [], "comments": [], "notes": []},
            f"status={opened.status_code} body={opened.text}",
        )

        legacy_target = project / "legacy.pdf"
        legacy_target.write_bytes(original)
        legacy_descriptor = client.get(
            "/api/workbench/open", params={"path": legacy_target.name}
        ).json()
        legacy_asset_id = legacy_descriptor.get("asset_id", "")
        legacy_route = f"/api/workbench/assets/{legacy_asset_id}/pdf/records"
        sidecar = project / ".legacy.pdf.scholarseed-annotations.json"
        sidecar.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "annotations": [
                        {
                            "id": "legacy-note",
                            "kind": "note",
                            "page": 1,
                            "quads": [[0.1, 0.2, 0.4, 0.25]],
                            "text": "immutable",
                            "note": "关键结论",
                            "color": "pink",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        legacy = client.get(legacy_route)
        revision = legacy.json().get("record_revision", "")
        source_revision = legacy.json().get("source_revision", "")
        check(
            "PDF records ignore obsolete adjacent sidecars",
            legacy.status_code == 200
            and legacy.json().get("records")
            == {"schema_version": 1, "marks": [], "comments": [], "notes": []},
            f"status={legacy.status_code} body={legacy.text}",
        )

        rejected_v1 = client.put(
            legacy_route,
            headers={"If-Match": f'"{revision}"'},
            json={
                "expected_source_revision": source_revision,
                "records": {"schema_version": 0, "annotations": []},
            },
        )
        check(
            "PDF records reject obsolete v1 payloads",
            rejected_v1.status_code == 422
            and rejected_v1.json().get("detail") == "invalid_annotations",
            f"status={rejected_v1.status_code} body={rejected_v1.text}",
        )

        records = {
            "schema_version": 1,
            "marks": [
                {
                    "id": "highlight-1",
                    "style": "highlight",
                    "color": "orange",
                    "page": 1,
                    "quads": [[0.1, 0.2, 0.4, 0.25]],
                    "text": "immutable",
                    "anchor_state": "anchored",
                    "created_at": 1.0,
                    "updated_at": 1.0,
                },
                {
                    "id": "underline-1",
                    "style": "underline",
                    "color": "blue",
                    "page": 1,
                    "quads": [[0.45, 0.2, 0.7, 0.25]],
                    "text": "source",
                    "anchor_state": "anchored",
                    "created_at": 1.0,
                    "updated_at": 1.0,
                },
                {
                    "id": "strikethrough-1",
                    "style": "strikethrough",
                    "color": "red",
                    "page": 1,
                    "quads": [[0.15, 0.3, 0.5, 0.35]],
                    "text": "obsolete claim",
                    "anchor_state": "anchored",
                    "created_at": 1.0,
                    "updated_at": 1.0,
                },
            ],
            "comments": [
                {
                    "id": "comment-1",
                    "mark_id": "highlight-1",
                    "body": "关键结论",
                    "created_at": 1.0,
                }
            ],
            "notes": [
                {
                    "id": "note-1",
                    "title": "笔记",
                    "body": "正文",
                    "excerpts": [
                        {
                            "id": "excerpt-1",
                            "mark_id": "highlight-1",
                            "text": "immutable",
                            "page": 1,
                        }
                    ],
                }
            ],
        }
        dangling = client.put(
            legacy_route,
            headers={"If-Match": f'"{revision}"'},
            json={
                "expected_source_revision": source_revision,
                "records": {
                    **records,
                    "comments": [
                        {"id": "bad", "mark_id": "missing", "body": "x", "created_at": 1.0}
                    ],
                },
            },
        )
        check(
            "PDF records 拒绝悬空 mark 引用",
            dangling.status_code == 422 and dangling.json().get("detail") == "invalid_annotations",
            f"status={dangling.status_code} body={dangling.text}",
        )
        saved = client.put(
            legacy_route,
            headers={"If-Match": f'"{revision}"'},
            json={"expected_source_revision": source_revision, "records": records},
        )
        next_revision = saved.json().get("record_revision", "")
        check(
            "PDF 批注只保存到项目库且原 PDF 与相邻文件不变",
            saved.status_code == 200
            and next_revision != revision
            and len(saved.json().get("records", {}).get("marks", [])) == 3
            and target.read_bytes() == original
            and legacy_target.read_bytes() == original
            and json.loads(sidecar.read_text(encoding="utf-8")).get("schema_version") == 1,
            f"status={saved.status_code} body={saved.text}",
        )

        conflict = client.put(
            legacy_route,
            headers={"If-Match": f'"{revision}"'},
            json={
                "expected_source_revision": source_revision,
                "records": {"schema_version": 1, "marks": [], "comments": [], "notes": []},
            },
        )
        check(
            "PDF records 拒绝旧 revision 覆盖",
            conflict.status_code == 412
            and conflict.json().get("detail") == "revision_conflict"
            and target.read_bytes() == original,
            f"status={conflict.status_code} body={conflict.text}",
        )

        content = client.app.state.content
        renamed = content.rename(content.project().id, legacy_target.name, "renamed.pdf")
        after_rename = client.get(legacy_route)
        check(
            "PDF 重命名后记录仍由同一 asset_id 读取",
            renamed.asset_id == legacy_asset_id
            and after_rename.status_code == 200
            and after_rename.json().get("records", {}).get("notes") == records["notes"],
            f"renamed={renamed} body={after_rename.text}",
        )
        (project / "archive").mkdir()

        with patch(
            "service.content.service.assets.rename_exclusive",
            side_effect=OSError("injected move failure"),
        ):
            move_error = ""
            try:
                content.move(content.project().id, renamed.path, "archive")
            except ContentError as error:
                move_error = error.code
        after_failed_move = client.get(legacy_route)
        check(
            "PDF 移动失败不留下新文件或错误记录关联",
            move_error == "move_failed"
            and (project / renamed.path).is_file()
            and not (project / "archive" / "renamed.pdf").exists()
            and after_failed_move.json().get("source_path") == renamed.path
            and after_failed_move.json().get("records", {}).get("notes") == records["notes"],
            f"error={move_error} body={after_failed_move.text}",
        )

        moved = content.move(content.project().id, renamed.path, "archive")
        after_move = client.get(legacy_route)
        check(
            "PDF 原子移动后记录仍由同一 asset_id 读取",
            moved.asset_id == legacy_asset_id
            and after_move.status_code == 200
            and after_move.json().get("records", {}).get("marks") == records["marks"],
            f"moved={moved} body={after_move.text}",
        )
        held = project.parent / f"{project.name}-held.pdf"
        (project / moved.path).rename(held)
        unavailable = client.get(legacy_route)
        check(
            "PDF 暂时失联时记录保留并明确返回 missing",
            unavailable.status_code == 200
            and unavailable.json().get("source_state") == "missing"
            and unavailable.json().get("records", {}).get("comments") == records["comments"],
            f"status={unavailable.status_code} body={unavailable.text}",
        )
        held.rename(project / moved.path)
        restored = client.get(legacy_route)
        check(
            "PDF 恢复后记录重新可定位",
            restored.status_code == 200
            and restored.json().get("source_state") == "available"
            and restored.json().get("source_path") == moved.path,
            f"status={restored.status_code} body={restored.text}",
        )

        first_dir = project / "same-a"
        second_dir = project / "same-b"
        first_dir.mkdir()
        second_dir.mkdir()
        (first_dir / "same.pdf").write_bytes(original)
        (second_dir / "same.pdf").write_bytes(original)
        first_open = client.get("/api/workbench/open", params={"path": "same-a/same.pdf"}).json()
        second_open = client.get("/api/workbench/open", params={"path": "same-b/same.pdf"}).json()
        first_records = client.get(
            f"/api/workbench/assets/{first_open['asset_id']}/pdf/records"
        ).json()
        second_records = client.get(
            f"/api/workbench/assets/{second_open['asset_id']}/pdf/records"
        ).json()
        check(
            "同名同内容不同目录 PDF 不串联 identity 或记录",
            first_open["asset_id"] != second_open["asset_id"]
            and first_records["record_target"]["subject_id"]
            != second_records["record_target"]["subject_id"]
            and first_records["records"]["notes"] == []
            and second_records["records"]["notes"] == [],
            f"first={first_records} second={second_records}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_pdf_records_survive_authorization_recovery() -> None:
    project = Path(tempfile.mkdtemp(prefix="file-workbench-reauthorize-"))
    external = Path(tempfile.mkdtemp(prefix="file-workbench-external-"))
    try:
        (external / "paper.pdf").write_bytes(b"%PDF-1.4\nlinked\n")
        client = _client(project)
        content = client.app.state.content
        project_id = content.project().id
        root = content.authorize_root(project_id, str(external), "关联资料")
        path = f"{root.mount_path}/paper.pdf"
        descriptor = client.get("/api/workbench/open", params={"path": path}).json()
        route = f"/api/workbench/assets/{descriptor['asset_id']}/pdf/records"
        initial = client.get(route).json()
        records = {
            "schema_version": 1,
            "marks": [],
            "comments": [],
            "notes": [{"id": "note", "title": "保留", "body": "授权恢复", "excerpts": []}],
        }
        saved = client.put(
            route,
            headers={"If-Match": f'"{initial["record_revision"]}"'},
            json={
                "expected_source_revision": initial["source_revision"],
                "records": records,
            },
        )
        content.revoke_root(root.root_id)
        revoked = client.get(route)
        restored_root = content.authorize_root(project_id, str(external), "关联资料")
        restored = client.get(route)
        check(
            "关联授权失效时保留记录且重新授权恢复原 identity",
            saved.status_code == 200
            and revoked.json().get("source_state") == "authorization_required"
            and revoked.json().get("records", {}).get("notes") == records["notes"]
            and restored_root.root_id == root.root_id
            and restored.json().get("source_state") == "available"
            and restored.json().get("record_target", {}).get("subject_id") == descriptor["asset_id"]
            and restored.json().get("records", {}).get("notes") == records["notes"],
            f"revoked={revoked.text} restored={restored.text}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)
        shutil.rmtree(external, ignore_errors=True)


EDITOR_SUFFIXES = (
    "md",
    "markdown",
    "py",
    "r",
    "js",
    "jsx",
    "ts",
    "tsx",
    "java",
    "c",
    "cpp",
    "h",
    "sh",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "txt",
    "log",
)


def test_editor_formats_open_save_and_reopen() -> None:
    """Every promised format traverses the real HTTP open and CAS storage path."""
    project = Path(tempfile.mkdtemp(prefix="file-workbench-formats-"))
    try:
        client = _client(project)
        for suffix in EDITOR_SUFFIXES:
            path = f"source.{suffix.upper()}"
            target = project / path
            target.write_text("before\n", encoding="utf-8")
            opened = client.get("/api/workbench/open", params={"path": path})
            payload = opened.json()
            capabilities = payload.get("capabilities", {})
            check(
                f"{suffix} open exposes editable text",
                opened.status_code == 200
                and payload.get("viewer")
                == ("markdown" if suffix in {"md", "markdown"} else "code")
                and capabilities.get("can_edit") is True
                and capabilities.get("can_save") is True,
                opened.text,
            )
            saved = client.put(
                "/api/workbench/content",
                params={"path": path},
                content=b"after\n",
                headers={
                    "Content-Type": "application/octet-stream",
                    "If-Match": f'"{payload.get("revision", "")}"',
                },
            )
            reopened = client.get("/api/workbench/content", params={"path": path})
            check(
                f"{suffix} CAS save and reopen preserve bytes",
                saved.status_code == 204
                and reopened.content == b"after\n"
                and target.read_bytes() == b"after\n",
                f"save={saved.status_code} read={reopened.status_code}",
            )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_markdown_images_persist() -> None:
    project = Path(tempfile.mkdtemp(prefix="markdown-images-"))
    try:
        document = project / "中文 notes (1).md"
        document.write_text("# Images\n", encoding="utf-8")
        client = _client(project)
        payload = b"\x89PNG\r\n\x1a\nimage-bytes"
        response = client.post(
            "/api/workbench/images",
            params={"path": document.name},
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        check("image upload succeeds", response.status_code == 200, response.text)
        if response.status_code != 200:
            return
        relative = response.json()["path"]
        check(
            "image path preserves full document name",
            relative.startswith(f".assert/{document.name}/img/"),
        )
        check("image bytes durable", (project / relative).read_bytes() == payload)
        second = client.post(
            "/api/workbench/images",
            params={"path": document.name},
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        check("repeated paste does not overwrite", second.json()["path"] != relative)
        check(
            "image can be reopened",
            client.get("/api/workbench/content", params={"path": relative}).content == payload,
        )
        for path in ("missing.md", "../escape.md"):
            denied = client.post(
                "/api/workbench/images",
                params={"path": path},
                content=payload,
                headers={"Content-Type": "image/png"},
            )
            check(f"reject invalid document {path}", denied.status_code >= 400)
        invalid = client.post(
            "/api/workbench/images",
            params={"path": document.name},
            content=b"text",
            headers={"Content-Type": "text/plain"},
        )
        check("reject non image", invalid.status_code == 400)
        outside = project.parent / f"{project.name}-outside"
        outside.mkdir()
        (project / "linked.md").write_text("# linked")
        (project / ".assert" / "linked.md").symlink_to(outside, target_is_directory=True)
        denied = client.post(
            "/api/workbench/images",
            params={"path": "linked.md"},
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        check("reject symlink escape", denied.status_code == 400 and not list(outside.iterdir()))
        outside.rmdir()
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_office_image_leases() -> None:
    project = Path(tempfile.mkdtemp(prefix="office-images-"))
    try:
        for name in ("document.docx", "other.docx"):
            (project / name).write_bytes(b"document")
        client = _client(project)
        route = "/api/workbench/office-images"
        image = BytesIO()
        Image.new("RGB", (2, 2), "blue").save(image, format="PNG")
        payload = image.getvalue()
        response = client.post(
            route,
            params={"path": "document.docx"},
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        check("office image staged", response.status_code == 200, response.text)
        if response.status_code != 200:
            return
        lease = response.json()
        asset = project / lease["path"]
        check("office image temporary namespace", lease["path"].startswith(".assert/tmp-img/"))
        check("office image bytes stored", asset.read_bytes() == payload)
        params = {"path": "document.docx", "lease": lease["lease"]}
        missing_revision = client.delete(route, params=params)
        check(
            "office image cleanup requires revision",
            missing_revision.status_code == 428 and asset.exists(),
        )
        wrong = client.delete(route, params=params, headers={"If-Match": "wrong"})
        check("office image cleanup checks revision", wrong.status_code == 412 and asset.exists())
        other = client.delete(
            route, params={**params, "path": "other.docx"}, headers={"If-Match": lease["revision"]}
        )
        check("office image scoped to document", other.status_code == 404 and asset.exists())
        traversal = client.delete(
            route,
            params={**params, "lease": "../document.docx"},
            headers={"If-Match": lease["revision"]},
        )
        check("office image rejects forged path", traversal.status_code == 400 and asset.exists())
        removed = client.delete(route, params=params, headers={"If-Match": lease["revision"]})
        check("office image exact cleanup", removed.status_code == 204 and not asset.exists())
        check("office source preserved", (project / "document.docx").read_bytes() == b"document")
        for path, media, data in (
            ("missing.docx", "image/png", payload),
            ("document.docx", "image/svg+xml", b"<svg/>"),
            ("document.docx", "image/png", b"not-png"),
            ("document.docx", "image/png", b"\x89PNG\r\n\x1a\n"),
        ):
            rejected = client.post(
                route, params={"path": path}, content=data, headers={"Content-Type": media}
            )
            check(f"office image rejects {path} {media} {len(data)}", rejected.status_code >= 400)
        (project / "text.md").write_text("text")
        non_docx = client.post(
            route,
            params={"path": "text.md"},
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        check("office image rejects non-DOCX source", non_docx.status_code == 400)
        subdir = project / "nested"
        subdir.mkdir()
        (subdir / "document.docx").write_bytes(b"document")
        with tempfile.TemporaryDirectory(prefix="office-image-outside-") as outside:
            (subdir / ".assert").symlink_to(outside, target_is_directory=True)
            escaped = client.post(
                route,
                params={"path": "nested/document.docx"},
                content=payload,
                headers={"Content-Type": "image/png"},
            )
            check(
                "office image rejects symlink escape",
                escaped.status_code >= 400 and not list(Path(outside).iterdir()),
            )
    finally:
        shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
    test_manual_raw_versioning_does_not_invent_preview_capabilities()
    test_office_image_leases()
    test_markdown_images_persist()
    test_large_editor_commit_crosses_old_64mib_ceiling()
    test_registered_preview_crosses_content_default_and_stops_at_500_mib()
    test_spreadsheets_share_zeta_viewer_and_fail_closed_for_complex_xlsx()
    test_office_documents_are_preview_only()
    test_editor_formats_open_save_and_reopen()
    test_open_binds_existing_snapshot()
    test_open_projects_versioning_without_a_resource_tree_scan()
    test_recreated_pdf_opens_with_an_isolated_identity()
    test_pdf_identity_conflict_is_a_structured_response()
    test_unknown_files_are_classified_by_content_for_basic_preview()
    test_head_and_range_use_same_revision()
    test_commit_requires_current_revision()
    test_pdf_records_are_database_only_and_revision_safe()
    test_pdf_records_survive_authorization_recovery()
    print(f"\nfile workbench contract: {PASS} passed, {FAIL} failed")
    raise SystemExit(1 if FAIL else 0)
