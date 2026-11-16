"""Consume the library-format descriptor through current Content decoders."""

import json
from pathlib import Path

from pypdf import PdfReader

from service.content.service.extract import decode_docx
from service.content.service.xlsx import decode as decode_xlsx
from service.content.service.xlsx import inspect as inspect_xlsx

ROOT = Path(__file__).resolve().parent


def test_four_format_fixtures_decode_from_descriptor(tmp_path: Path) -> None:
    descriptor = json.loads((ROOT / "scenario.json").read_text(encoding="utf-8"))
    assert descriptor["id"] == ROOT.name
    assert descriptor["drive"] == "cmd.jsonl"

    paths = {}
    for item in descriptor["project"]["files"]:
        source = ROOT / item["contentFrom"]
        target = tmp_path / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        paths[target.suffix] = target

    assert set(paths) == {".docx", ".xlsx", ".md", ".pdf"}
    docx_text = decode_docx(paths[".docx"].read_bytes())
    assert "18 volunteers across three teams" in docx_text
    assert "no comparison group" in docx_text

    xlsx_bytes = paths[".xlsx"].read_bytes()
    assert inspect_xlsx(xlsx_bytes).editable
    xlsx_text = decode_xlsx(xlsx_bytes)
    assert "[Sheet: Equipment]" in xlsx_text
    assert "Scanner\t20\t15" in xlsx_text
    assert "Workstation\t32\t24" in xlsx_text

    md_text = paths[".md"].read_text(encoding="utf-8")
    assert "Eight of the eleven participants" in md_text
    assert "No usage telemetry" in md_text

    pdf_text = "\n".join(page.extract_text() for page in PdfReader(paths[".pdf"]).pages)
    assert "internal pilot starts on 6 November 2026" in pdf_text
    assert "No external release date has been set" in pdf_text
