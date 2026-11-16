from __future__ import annotations

import unittest
from io import BytesIO
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject
from reportlab.pdfgen.canvas import Canvas

from apps.serve.tests.pdf import PageFixture, TextFixture, annotated_pdf, build_pdf
from service.platform.pdf import (
    PDF_ANNOTATIONS_ATTACHMENT,
    embedded_pdf_records,
    pdf_document_info,
    pdf_metadata,
    pdf_page_body_text,
    pdf_page_layout,
    render_pdf_page,
)
from service.platform.records import EMPTY_RECORDS, encode_records
from service.workbench.service.extraction import index_identity


class PdfEngineContracts(unittest.TestCase):
    def test_native_marks_preserve_selected_text_comments_and_explicit_replies(self) -> None:
        payload = annotated_pdf()
        records = embedded_pdf_records(payload)
        self.assertEqual(len(records["marks"]), 2)
        mark, point = records["marks"]
        self.assertEqual(mark["text"], "Left evidence\nSecond line")
        self.assertEqual(mark["style"], "highlight")
        self.assertNotIn("Unselected", mark["text"])
        self.assertEqual(
            [c["body"] for c in records["comments"]], ["原来的评论", "明确回复", "独立的阅读想法"]
        )
        self.assertEqual([c["mark_id"] for c in records["comments"][:2]], [mark["id"], mark["id"]])
        self.assertEqual(point["style"], "comment")
        self.assertEqual(point["text"], "")
        self.assertEqual(records, embedded_pdf_records(payload))

    def test_native_marks_normalize_crop_and_rotation_without_losing_text(self) -> None:
        records = embedded_pdf_records(annotated_pdf(rotation=90, crop=True))
        self.assertEqual(len(records["marks"]), 2)
        mark = records["marks"][0]
        self.assertEqual(mark["text"], "Left evidence\nSecond line")
        expected = [666 / 740, 38 / 560, 682 / 740, 125 / 560]
        for actual, wanted in zip(mark["quads"][0], expected):
            self.assertAlmostEqual(actual, wanted, places=5)

    def test_invalid_embedded_attachment_does_not_hide_valid_native_marks(self) -> None:
        writer = PdfWriter(clone_from=PdfReader(BytesIO(annotated_pdf())))
        writer.add_attachment(PDF_ANNOTATIONS_ATTACHMENT, b"not json")
        output = BytesIO()
        writer.write(output)
        records = embedded_pdf_records(output.getvalue())
        self.assertEqual(len(records["marks"]), 2)

    def test_native_import_merges_existing_records_and_never_reimports_deleted_marks(self) -> None:
        payload = annotated_pdf()
        imported = embedded_pdf_records(payload)
        original = {key: value for key, value in imported.items() if key != "native_annotations"}
        self.assertEqual(embedded_pdf_records(payload, original), imported)
        deleted = {**imported, "marks": [], "comments": []}
        self.assertEqual(embedded_pdf_records(payload, deleted), deleted)

    def test_native_reply_chains_remain_on_the_original_mark(self) -> None:
        writer = PdfWriter(clone_from=PdfReader(BytesIO(annotated_pdf())))
        reply = writer.pages[0]["/Annots"][1]
        raw = reply.get_object()
        assert isinstance(raw, DictionaryObject)
        writer.add_annotation(
            0,
            DictionaryObject(
                {
                    NameObject("/Subtype"): NameObject("/Text"),
                    NameObject("/Rect"): raw["/Rect"],
                    NameObject("/IRT"): reply,
                    NameObject("/Contents"): TextStringObject("Reply to reply"),
                }
            ),
        )
        output = BytesIO()
        writer.write(output)
        records = embedded_pdf_records(output.getvalue())
        self.assertEqual(len(records["marks"]), 2)
        self.assertEqual(records["comments"][-1]["mark_id"], records["marks"][0]["id"])

    def test_new_external_notes_after_export_do_not_resurrect_deleted_native_marks(self) -> None:
        payload = annotated_pdf()
        deleted = {**embedded_pdf_records(payload), "marks": [], "comments": []}
        writer = PdfWriter(clone_from=PdfReader(BytesIO(payload)))
        writer.add_attachment(PDF_ANNOTATIONS_ATTACHMENT, encode_records(deleted))
        raw = writer.pages[0]["/Annots"][1].get_object()
        assert isinstance(raw, DictionaryObject)
        writer.add_annotation(
            0,
            DictionaryObject(
                {
                    NameObject("/Subtype"): NameObject("/Text"),
                    NameObject("/Rect"): raw["/Rect"],
                    NameObject("/Contents"): TextStringObject("New external note after export"),
                }
            ),
        )
        output = BytesIO()
        writer.write(output)
        records = embedded_pdf_records(output.getvalue())
        self.assertEqual(len(records["marks"]), 1)
        self.assertEqual(
            [c["body"] for c in records["comments"]], ["New external note after export"]
        )

    def test_new_reply_to_an_imported_reply_keeps_its_thread(self) -> None:
        payload = annotated_pdf()
        imported = embedded_pdf_records(payload)
        writer = PdfWriter(clone_from=PdfReader(BytesIO(payload)))
        reply = writer.pages[0]["/Annots"][1]
        raw = reply.get_object()
        assert isinstance(raw, DictionaryObject)
        writer.add_annotation(
            0,
            DictionaryObject(
                {
                    NameObject("/Subtype"): NameObject("/Text"),
                    NameObject("/Rect"): raw["/Rect"],
                    NameObject("/IRT"): reply,
                    NameObject("/Contents"): TextStringObject("New threaded reply"),
                }
            ),
        )
        output = BytesIO()
        writer.write(output)
        records = embedded_pdf_records(output.getvalue(), imported)
        self.assertEqual(len(records["marks"]), 2)
        self.assertEqual(records["comments"][-1]["mark_id"], imported["marks"][0]["id"])
        deleted = {**imported, "marks": [], "comments": []}
        recovered = embedded_pdf_records(output.getvalue(), deleted)
        self.assertEqual(len(recovered["marks"]), 1)
        self.assertEqual([c["body"] for c in recovered["comments"]], ["New threaded reply"])

    def test_native_text_preserves_positioned_word_gaps(self) -> None:
        stream = BytesIO()
        canvas = Canvas(stream, pagesize=(600, 800))
        canvas.setFont("Helvetica", 12)
        canvas.drawString(60, 700, "First")
        canvas.drawString(90, 700, "second")
        canvas.save()
        writer = PdfWriter(clone_from=PdfReader(BytesIO(stream.getvalue())))
        writer.add_annotation(
            0,
            DictionaryObject(
                {
                    NameObject("/Subtype"): NameObject("/Highlight"),
                    NameObject("/Rect"): ArrayObject([FloatObject(n) for n in (58, 697, 135, 713)]),
                    NameObject("/QuadPoints"): ArrayObject(
                        [FloatObject(n) for n in (58, 713, 135, 713, 58, 697, 135, 697)]
                    ),
                }
            ),
        )
        output = BytesIO()
        writer.write(output)
        self.assertEqual(
            embedded_pdf_records(output.getvalue())["marks"][0]["text"], "First second"
        )

    def test_successful_empty_native_scan_is_recorded(self) -> None:
        payload = build_pdf(PageFixture(texts=(TextFixture(72, 72, "No marks"),)))
        self.assertEqual(embedded_pdf_records(payload).get("native_annotations"), [])

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

        self.assertEqual(embedded_pdf_records(payload), {**EMPTY_RECORDS, "native_annotations": []})


if __name__ == "__main__":
    unittest.main()
