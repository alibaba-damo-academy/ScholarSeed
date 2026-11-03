"""Rebuild one synthetic DOCX or PDF fixture in this directory."""

import argparse
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent


def build_docx() -> None:
    document = Document()
    section = document.sections[0]
    section.top_margin = Inches(0.9)
    section.bottom_margin = Inches(0.9)
    normal = document.styles["Normal"]
    normal.font.name = "Arial"
    normal.font.size = Pt(11)
    for name in ("Title", "Heading 1"):
        style = document.styles[name]
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.underline = False
        properties = style._element.pPr
        if properties is not None:
            border = properties.find(qn("w:pBdr"))
            if border is not None:
                properties.remove(border)

    document.add_paragraph("Harbor Lab Pilot Brief", style="Title")
    document.add_paragraph(
        "This synthetic memo records the scope and evidence limits of an internal "
        "document workspace pilot. All people and results are fictional."
    )
    document.add_heading("Scope and design", level=1)
    document.add_paragraph(
        "From 1 to 28 September 2026, the pilot included 18 volunteers across "
        "three teams. It had no comparison group."
    )
    document.add_heading("Evidence limit", level=1)
    document.add_paragraph(
        "Participants could open a document and inspect project notes. This memo "
        "does not report task speed or error reduction."
    )
    document.save(ROOT / "pilot-brief.docx")


def build_pdf() -> None:
    target = ROOT / "rollout-note.pdf"
    page = canvas.Canvas(str(target), pagesize=A4, pageCompression=0)
    page.setTitle("Harbor Lab Rollout Note")
    page.setAuthor("ScholarSeed synthetic evaluation fixture")

    page.setFont("Helvetica-Bold", 18)
    page.drawString(54, 780, "Harbor Lab Rollout Note")
    page.setFont("Helvetica", 10)
    page.drawString(54, 752, "Synthetic internal pilot note; all dates and plans are fictional.")
    page.setFont("Helvetica-Bold", 12)
    page.drawString(54, 708, "Scope")
    page.setFont("Helvetica", 11)
    page.drawString(
        54, 688, "The rollout is limited to an internal pilot. It is not a public release."
    )
    page.setFont("Helvetica-Bold", 12)
    page.drawString(54, 648, "Schedule")
    page.setFont("Helvetica", 11)
    page.drawString(54, 628, "The internal pilot starts on 6 November 2026.")
    page.drawString(54, 610, "No external release date has been set.")
    page.setFont("Helvetica", 9)
    page.drawString(54, 48, "Harbor Lab | Evaluation fixture | 1")
    page.showPage()
    page.save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("format", choices=("docx", "pdf"))
    args = parser.parse_args()
    if args.format == "docx":
        build_docx()
    else:
        build_pdf()
