"""Bounded, local Markdown structure and DOCX conversion checks before refinement."""

import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import slr_paths
from docx import Document
from docx.image.exceptions import (
    InvalidImageStreamError,
    UnexpectedEndOfFileError,
    UnrecognizedImageError,
)
from docx.image.image import Image as WordImage
from equations import equation
from evidence import read, save
from manuscript_publication import native_heading_ids
from PIL import Image, UnidentifiedImageError
from platform_runtime import utf8_env
from taxonomy import tree_sources
from word import ANCHOR, HEADING_IDENTIFIER, MATH_TOKEN, export, parse

TIMEOUT_SECONDS = 2
MAX_ISSUES = 12
MAX_NOTE_BYTES = 4096
EXCERPT_CHARS = 140
MAX_WORKER_LOG_CHARS = 4096
SCRATCH_DIRECTORY = "05_generation/_internal"
SCRATCH_PREFIX = "source-precheck-"
REPORT_NAME = "report.json"
TRIAL_NAME = "trial.docx"
LOG_NAME = "worker.log"
SOURCE_PRECHECK_REPORT = "_status/source_precheck.json"
SOURCE_PRECHECK_NOTES = "source_precheck.txt"
SOURCE_PRECHECK_TIMEOUT_KEY = "source_precheck_timeout_sec"
SUCCESS = "SUCCESS"
FAILED = "FAILED"
WARNING = "WARNING"
PARTIAL = "PARTIAL_SUCCESS"
TIMEOUT = "TIMEOUT"
UNAVAILABLE = "UNAVAILABLE"
SKIPPED = "SKIPPED"
MARKDOWN = "markdown"
DOCX = "docx"
IMAGE_ERRORS = (
    OSError,
    ValueError,
    UnrecognizedImageError,
    UnexpectedEndOfFileError,
    InvalidImageStreamError,
)
MESSAGES = {
    "markdown_structure": (
        "章节标识冲突；保留原有链接含义，修复重复标识。",
        "Conflicting heading identifiers; repair the identifiers without breaking links.",
    ),
    "missing_image": (
        "本地图片依赖不存在；核对真实路径，不编造替代图片或删除必要图表。",
        "Local image dependency is missing; use a verified path, not an invented replacement or deletion.",
    ),
    "image_boundary": (
        "图片不在可交付的本地依赖范围内；核对发布依赖，不读取外部文件。",
        "Image lies outside local publication dependencies; check the dependency boundary.",
    ),
    "image_decode": (
        "本地图片无法由当前转换器读取；核对实际图片格式。",
        "The local image cannot be read by the current converter; check its actual format.",
    ),
    "native_figure": (
        "原生图依赖缺失或源码结构不符合现有出版契约；保留图意，不用占位图代替。",
        "Native figure dependency or source structure is invalid; preserve its meaning, not a placeholder.",
    ),
    "docx_conversion": (
        "当前DOCX转换器不支持该处内容；保留科学含义，改用支持的等价表达，不能靠删除内容绕过。",
        "DOCX conversion failed at this content; use a supported equivalent without deleting scientific content.",
    ),
}


def source_hash(source):
    return hashlib.sha256(Path(source).read_bytes()).hexdigest()


def _inline_nodes(tokens):
    for token in tokens:
        if token.type == "inline":
            for child in token.children or []:
                yield token, child


def _conversion_location(tokens, error):
    message = str(error)
    kind = message.rsplit(": ", 1)[-1]
    for token in tokens:
        if token.type == kind and token.map:
            return token.map[0] + 1, token.content
    for parent, child in _inline_nodes(tokens):
        if child.type == MATH_TOKEN:
            try:
                equation(child.content)
            except ValueError:
                return parent.map[0] + 1, child.content
        if child.type == kind and not (kind == "html_inline" and ANCHOR.fullmatch(child.content)):
            return parent.map[0] + 1, child.content
    return None, ""


def _heading_location(tokens, error):
    identifier = str(error).rsplit(": ", 1)[-1]
    locations = []
    for index, token in enumerate(tokens[:-1]):
        if token.type != "heading_open" or not token.map:
            continue
        inline = tokens[index + 1]
        if not inline.children or inline.children[-1].type != "text":
            continue
        match = HEADING_IDENTIFIER.search(inline.children[-1].content)
        if match and match[1] == identifier:
            locations.append(token.map[0] + 1)
    return locations[1] if len(locations) > 1 else next(iter(locations), None)


def inspect_source(source, requested_format, destination, language="english"):
    source = Path(source).resolve()
    if Path(destination).resolve() == source:
        raise ValueError("Precheck destination must not replace the original source")
    root = source.parent
    content = source.read_text(encoding="utf-8")
    report = {
        "status": SUCCESS,
        "requested_format": requested_format,
        "issues": [],
        "skipped": [],
        "trial_export": SKIPPED,
        "issues_omitted": 0,
        "source_sha256": source_hash(source),
        "scope": "Structure and conversion, not visual layout.",
    }

    def issue(code, line, excerpt):
        if len(report["issues"]) < MAX_ISSUES:
            report["issues"].append(
                {
                    "code": code,
                    "target": "main",
                    "source_line": line,
                    "excerpt": excerpt[:EXCERPT_CHARS],
                }
            )
        else:
            report["issues_omitted"] += 1

    def skip(reason):
        report["skipped_count"] = report.get("skipped_count", 0) + 1
        if reason not in report["skipped"]:
            report["skipped"].append(reason)

    tokens = parse(content)
    try:
        native_heading_ids(content)
    except ValueError as error:
        line = _heading_location(tokens, error)
        issue("markdown_structure", line, content.splitlines()[line - 1] if line else "")
    for parent, child in _inline_nodes(tokens):
        if child.type != "image":
            continue
        relative = child.attrGet("src") or ""
        line = parent.map[0] + 1
        if not Path(relative).is_absolute() and urlsplit(relative).scheme:
            if requested_format == DOCX:
                issue("image_boundary", line, child.content)
            else:
                skip("Remote image was not fetched.")
            continue
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            issue("image_boundary", line, relative)
        elif not path.is_file():
            issue("missing_image", line, relative)
        elif path.suffix.lower() == ".tex":
            try:
                tree_sources(f"![Native figure]({relative})", root)
            except ValueError:
                issue("native_figure", line, relative)
            else:
                skip("Native figure requires publication rendering; no precheck compilation.")
        else:
            try:
                if requested_format == DOCX:
                    WordImage.from_file(str(path))
                else:
                    with Image.open(path) as image:
                        image.verify()
            except UnidentifiedImageError:
                skip("Image format was not verified by the local decoder.")
            except IMAGE_ERRORS:
                issue("image_decode", line, relative)
    if requested_format == DOCX and not report["issues"] and not report["skipped"]:
        try:
            export(content, root, destination, language)
            document = Document(destination)
        except ValueError as error:
            line, excerpt = _conversion_location(tokens, error)
            if line is not None or excerpt:
                issue("docx_conversion", line, excerpt)
            else:
                skip("DOCX conversion failed without a source location; inspect local diagnostics.")
                report["conversion_error"] = str(error)[:MAX_WORKER_LOG_CHARS]
            report["trial_export"] = FAILED
        else:
            report["trial_export"] = SUCCESS
            report["document"] = {
                "tables": len(document.tables),
                "images": len(document.inline_shapes),
                "math_objects": len(document.element.xpath("//m:oMath")),
            }
    report["status"] = WARNING if report["issues"] else PARTIAL if report["skipped"] else SUCCESS
    return report


def precheck(
    workspace, source, requested_format, language="english", timeout_seconds=TIMEOUT_SECONDS
):
    if requested_format not in (MARKDOWN, DOCX):
        raise ValueError("Source precheck accepts Markdown authoring only")
    source = Path(source).resolve()
    internal = Path(workspace).resolve() / SCRATCH_DIRECTORY
    internal.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix=SCRATCH_PREFIX, dir=internal))
    report_path = folder / REPORT_NAME
    environment = utf8_env()
    profile = slr_paths.resolve_profile()
    module_paths = [
        str(path)
        for component in ("lib", "scripts")
        for path in slr_paths.module_dirs(component, profile)
    ]
    if environment.get("PYTHONPATH"):
        module_paths.append(environment["PYTHONPATH"])
    environment["PYTHONPATH"] = os.pathsep.join(module_paths)
    fingerprint = source_hash(source)
    command = [
        sys.executable,
        "-B",
        "-X",
        "utf8",
        str(Path(__file__).resolve()),
        "--source",
        str(source),
        "--format",
        requested_format,
        "--report",
        str(report_path),
        "--destination",
        str(folder / TRIAL_NAME),
        "--language",
        language,
        "--sha256",
        fingerprint,
    ]
    started = time.monotonic()
    report = {
        "status": UNAVAILABLE,
        "requested_format": requested_format,
        "issues": [],
        "source_sha256": fingerprint,
        "trial_export": SKIPPED,
        "skipped": [],
        "issues_omitted": 0,
    }
    try:
        result = subprocess.run(
            command,
            cwd=slr_paths.HOME,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        save(folder / LOG_NAME, (result.stdout + result.stderr)[-MAX_WORKER_LOG_CHARS:])
        if result.returncode == 0 and report_path.is_file():
            report = read(report_path)
        else:
            report.update(worker_returncode=result.returncode, error_log=str(folder / LOG_NAME))
    except subprocess.TimeoutExpired:
        report["status"] = TIMEOUT
    except OSError as error:
        report["status"] = UNAVAILABLE
        report["error_type"] = type(error).__name__
    report.update(
        duration_sec=round(time.monotonic() - started, 3),
        report_path=str(report_path),
        command=command,
    )
    save(report_path, report)
    return report


def diagnostic_notes(report, language="english"):
    issues = [
        item
        for item in report.get("issues", [])
        if item.get("source_line") is not None or item.get("excerpt")
    ]
    if not issues:
        return ""
    chinese = language.lower() == "chinese"
    header = (
        "源码预检查发现以下格式问题，这些提示不替代全文精修。修复所列问题时保留科学含义，不能删除公式或图表来绕过错误。"
        "位置对应原始v1源码，不是最终页面。\n"
        if chinese
        else "Source precheck found these format issues; these notes do not replace whole-document refinement. "
        "Repair the listed content without deleting formulas or "
        "assets to bypass errors. Locations refer to the original v1 source, not rendered pages.\n"
    )
    rows = []
    for item in issues:
        line = item.get("source_line")
        location = (
            (f"第{line}行附近" if line else "位置待核对")
            if chinese
            else (f"near line {line}" if line else "location unresolved")
        )
        message = MESSAGES[item["code"]][0 if chinese else 1]
        rows.append(f'{len(rows) + 1}. {location}：{message} “{item.get("excerpt", "")}”')
    notes = header
    shown = 0
    reserve = (
        "\n另有问题未列出，完整记录保留在本地。"
        if chinese
        else "\nAdditional issues omitted; full diagnostics remain local."
    )
    for row in rows:
        if len((notes + row + "\n" + reserve).encode("utf-8")) > MAX_NOTE_BYTES:
            break
        notes += row + "\n"
        shown += 1
    if shown < len(rows) or report.get("issues_omitted"):
        notes += reserve
    return notes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--format", choices=(MARKDOWN, DOCX), required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--language", default="english")
    parser.add_argument("--sha256", required=True)
    arguments = parser.parse_args()
    if source_hash(arguments.source) != arguments.sha256:
        return 1
    report = inspect_source(
        arguments.source, arguments.format, arguments.destination, arguments.language
    )
    if source_hash(arguments.source) != arguments.sha256:
        return 1
    save(arguments.report, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
