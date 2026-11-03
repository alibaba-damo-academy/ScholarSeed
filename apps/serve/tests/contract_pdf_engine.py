from __future__ import annotations

import unittest
from io import BytesIO
from unittest.mock import patch

from pypdf.errors import PdfReadError
from reportlab.pdfgen.canvas import Canvas

from apps.serve.tests.pdf import PageFixture, TextFixture, build_pdf
from service.platform.pdf import (
    PDF_ANNOTATIONS_ATTACHMENT,
    pdf_document_info,
    pdf_metadata,
    pdf_page_body_text,
    pdf_page_layout,
    render_pdf_page,
)
from service.platform.records import EMPTY_RECORDS, encode_records
from service.workbench.service.extraction import index_identity


class PdfEngineContracts(unittest.TestCase):
    def test_translation_excludes_repeated_decorations_without_reformatting_body(self) -> None:
        stream = BytesIO()
        canvas = Canvas(stream, pagesize=(600, 800))
        for page in range(3):
            canvas.setFont("Helvetica", 10)
            canvas.drawString(60, 770, "Repeated preprint header")
            canvas.drawString(60, 650, f"Body content on page {page}")
            canvas.saveState()
            canvas.translate(100, 300)
            canvas.rotate(30)
            canvas.setFont("Helvetica", 36)
            canvas.drawString(0, 0, "REPEATED WATERMARK")
            canvas.restoreState()
            canvas.showPage()
        canvas.save()
        original = (
            "Repeated preprint header\nREPEATED WATERMARK\nBody content on page 1\n  Table   123"
        )
        self.assertEqual(
            pdf_page_body_text(stream.getvalue(), 2, original),
            "Body content on page 1\n  Table   123",
        )
        ambiguous = original + "\nRepeated preprint header"
        self.assertEqual(
            pdf_page_body_text(stream.getvalue(), 2, ambiguous).count("Repeated preprint header"),
            2,
        )

    def test_translation_retains_unique_headers_and_small_rotated_text(self) -> None:
        stream = BytesIO()
        canvas = Canvas(stream, pagesize=(600, 800))
        for page in range(2):
            canvas.setFont("Helvetica", 10)
            canvas.drawString(60, 770, f"Unique heading {page}")
            canvas.drawString(60, 650, "Body text remains intact here")
            canvas.saveState()
            canvas.translate(100, 300)
            canvas.rotate(30)
            canvas.drawString(0, 0, "Rotated axis label")
            canvas.restoreState()
            canvas.showPage()
        canvas.save()
        original = "Unique heading 0\nBody text remains intact here\nRotated axis label"
        self.assertEqual(pdf_page_body_text(stream.getvalue(), 1, original), original)

    def test_malformed_xmp_does_not_hide_document_metadata(self) -> None:
        class BrokenXmpReader:
            metadata = {"/Title": "Readable title"}

            @property
            def xmp_metadata(self):
                raise PdfReadError("malformed xmp")

        with patch(
            "service.platform.pdf._reader",
            return_value=(BrokenXmpReader(), False),
        ):
            metadata = pdf_metadata(b"unused")

        self.assertEqual(metadata.title, "Readable title")
        self.assertEqual(metadata.xmp, "")

    def test_extractor_version_change_invalidates_cached_index_identity(self) -> None:
        revision = "sha256:" + "a" * 64
        current = index_identity(revision)
        with patch(
            "service.workbench.service.extraction.EXTRACTOR_VERSION",
            "previous-pdf-engine",
        ):
            previous = index_identity(revision)
        self.assertNotEqual(current, previous)

    def test_structure_layout_and_rendering_share_one_page_contract(self) -> None:
        payload = build_pdf(
            PageFixture(
                texts=(
                    TextFixture(72, 72, "First column"),
                    TextFixture(320, 72, "Second column"),
                    TextFixture(72, 120, "中文 CJK"),
                )
            ),
            title="Contract title",
            author="Ada Example",
        )

        info = pdf_document_info(payload)
        metadata = pdf_metadata(payload)
        layout = pdf_page_layout(payload, 1)
        image = render_pdf_page(payload, 1, scale=1.0)

        self.assertEqual(info.page_count, 1)
        self.assertFalse(info.encrypted)
        self.assertEqual(metadata.title, "Contract title")
        self.assertEqual(metadata.author, "Ada Example")
        self.assertIn("First column", layout.text)
        self.assertIn("Second column", layout.text)
        self.assertTrue(any(word.text == "First" for word in layout.words))
        self.assertGreater(len(layout.characters), 10)
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(image.size, (600, 800))

    def test_embedded_records_are_read_through_structural_engine(self) -> None:
        payload = build_pdf(
            PageFixture(texts=(TextFixture(72, 72, "Annotated"),)),
            attachment=(PDF_ANNOTATIONS_ATTACHMENT, encode_records(EMPTY_RECORDS)),
        )

        from service.platform.pdf import embedded_pdf_records

        self.assertEqual(embedded_pdf_records(payload), EMPTY_RECORDS)


if __name__ == "__main__":
    unittest.main()
