"""Publication availability and user-facing choices for outline review."""

import json
import shutil
import subprocess
from pathlib import Path

from language_plan import publication_language, resolved_language_map
from processing.audit_citation_metadata import audit
from processing.build_bib import build
from task_contract import publication_view, read_request
from templates import list_templates, resolve_citation_style


def publication_options(ws):
    request = read_request(ws)
    language = request["language"]
    fmt = publication_view(request)["format"]
    outline_path = Path(ws) / "04_outline/outline.json"
    if outline_path.exists():
        outline = json.loads(outline_path.read_text())
        language = publication_language(resolved_language_map(outline, language)).upper()
    templates = []
    for row in list_templates():
        if row.get("language", "ENGLISH") != language:
            continue
        compiler = "xelatex" if language == "CHINESE" else "pdflatex"
        usable = (
            row["status"] == "installed"
            and bool(shutil.which(compiler))
            and bool(shutil.which("bibtex"))
        )
        if language == "CHINESE" and usable:
            found = (
                subprocess.run(["kpsewhich", "ctexart.cls"], capture_output=True, text=True)
                if shutil.which("kpsewhich")
                else None
            )
            usable = bool(found and found.returncode == 0 and found.stdout.strip())
        pdf_label = (
            "PDF（推荐）：中文排版，含参考文献列表。"
            if language == "CHINESE"
            else "PDF (recommended): English typesetting with a reference list."
        )
        templates.append({"id": row["id"], "title": pdf_label, "usable": usable})
    if not (Path(ws) / "03_process/references.bib").exists():
        _, status = build(Path(ws))
        if status["status"] == "FAILED":
            raise ValueError(status.get("status_reason", "bibliography preparation failed"))
    try:
        metadata = audit(ws)["styles"]
    except (ValueError, OSError):
        metadata = {}
    citations = []
    chinese_citation_labels = {
        "numeric": "数字编号条目",
        "author_year": "作者—年份条目",
        "ieee": "IEEE 编号条目（含卷期页），条目信息可能存在不完整。",
        "acm": "ACM 参考文献格式",
    }
    english_citation_labels = {
        "numeric": "Numbered references",
        "author_year": "Author–year references",
        "ieee": "IEEE numbered references (including volume, issue, and pages); some entry details may be incomplete.",
        "acm": "ACM Reference Format",
    }
    for sid in ("numeric", "author_year", "ieee", "acm"):
        row = resolve_citation_style(sid)
        coverage = metadata.get(sid, {})
        label = (chinese_citation_labels if language == "CHINESE" else english_citation_labels)[sid]
        citations.append(
            {
                "id": sid,
                "label": label,
                "usable": bool(row.get("available"))
                and bool(coverage)
                and coverage.get("minimum_ready") == coverage.get("entries"),
                "metadata": {key: coverage.get(key) for key in ("minimum_ready", "entries")},
            }
        )
    format_labels = (
        {
            "markdown": "Markdown：可编辑文档，含参考文献列表。",
            "latex_pdf": "PDF（推荐）：中文排版，含参考文献列表。",
        }
        if language == "CHINESE"
        else {
            "markdown": "Markdown: editable document with a reference list.",
            "latex_pdf": "PDF (recommended): English typesetting with a reference list.",
        }
    )
    return {
        "templates": templates,
        "citation_styles": citations,
        "formats": ["markdown"]
        + (["latex_pdf"] if any(option["usable"] for option in templates) else []),
        "format_labels": format_labels,
    }


def validate_publication_choice(ws, choice, options=None):
    options = publication_options(ws) if options is None else options
    if choice.get("format") not in options["formats"]:
        raise ValueError("selected output format is not available in this environment")
    if choice.get("format") == "latex_pdf" and not any(
        option["id"] == choice.get("template") and option["usable"]
        for option in options["templates"]
    ):
        raise ValueError("selected template is not usable for the current language/environment")
    if not any(
        option["id"] == choice.get("citation_style") and option["usable"]
        for option in options["citation_styles"]
    ):
        raise ValueError(
            "citation style metadata is incomplete; repair the named corpus metadata first"
        )
