"""Behavior tests: losing source material, false links and unsafe output writes."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from pypdf import PdfWriter
from pypdf.annotations import Text
from pypdf.generic import NameObject
from pdf_fixture import document_pdf, markup, text_rect

ROOT = Path(__file__).resolve().parents[1]


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="extract-test-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def pdf(self, embedded=None, *, native=True):
        path = self.dir / "input.pdf"
        attachments = {} if embedded is None else {'scholarseed-annotations.json': json.dumps(embedded).encode()}
        document_pdf(path, [{'texts': [
            {'at': (40, 60), 'text': 'First highlighted phrase.'},
            {'at': (40, 90), 'text': 'Second line of the claim.'},
            {'at': (40, 130), 'text': 'Unrelated paragraph.'}],
            'marks': [{'phrases': ['First highlighted phrase.'], 'comment': 'Need evidence?'}] if native else []}],
            size=(500, 500), attachments=attachments)
        writer = PdfWriter(clone_from=path)
        writer.set_page_label(0, 0, style='/D', start=672)
        writer.write(path)
        return path

    def extract(self, path, *args, ok=True):
        out = self.dir / ("output-" + str(len(list(self.dir.glob("output-*")))))
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/extract_pdf.py"), str(path),
                               "--out-dir", str(out), *map(str, args)], capture_output=True, text=True)
        if ok:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue((out / "bundle.json").is_file(), proc.stdout)
            return json.loads((out / "bundle.json").read_text()), out
        return proc, out


    def test_physical_page_and_pdf_label_are_distinct(self):
        bundle, _ = self.extract(self.pdf())
        self.assertEqual(bundle["records"][0]["page"], 1)
        self.assertEqual(bundle["records"][0]["page_label"], "672")

    def test_multiline_highlight_does_not_capture_unselected_text(self):
        path = self.pdf(native=False)
        writer = PdfWriter(clone_from=path)
        markup(writer, writer.pages[0], [text_rect(text, origin, text) for text, origin in (
            ('First highlighted phrase.', (40, 60)), ('Second line of the claim.', (40, 90)))])
        dest = self.dir / "multiline.pdf"
        writer.write(dest)
        bundle, _ = self.extract(dest)
        text = bundle["records"][0]["text"]
        self.assertIn("First highlighted phrase.", text)
        self.assertIn("Second line of the claim.", text)
        self.assertNotIn("Unrelated", text)

    def test_cross_column_quad_order_preserves_reading_sequence(self):
        for kind, expected in (('Highlight', 'highlight'), ('Underline', 'underline'),
                               ('StrikeOut', 'strikethrough'), ('Squiggly', 'squiggly')):
            with self.subTest(kind=kind):
                path = self.dir / f'columns-{kind}.pdf'
                document_pdf(path, [{'texts': [
                    {'at': (40, 500), 'text': 'left column ending'},
                    {'at': (330, 60), 'text': 'right column continuation'}],
                    'marks': [{'phrases': ['left column ending', 'right column continuation'], 'kind': kind}]}],
                    size=(600, 600))
                bundle, _ = self.extract(path)
                self.assertEqual(len(bundle['records']), 1)
                self.assertEqual(bundle['records'][0]['kind'], expected)
                self.assertLess(bundle["records"][0]["text"].index("left"), bundle["records"][0]["text"].index("right"))

    def test_native_extraction_does_not_claim_visual_review_or_invent_notes(self):
        bundle, out = self.extract(self.pdf())
        self.assertEqual(bundle["coverage"]["channels"]["visual"]["status"], "pending")
        self.assertEqual(bundle["coverage"]["raw_counts"]["embedded_note"], 0)
        self.assertEqual(bundle["coverage"]["raw_counts"]["external_note"], 0)
        self.assertIn("pending", (out / "coverage.md").read_text())

    def test_sticky_note_has_candidates_without_asserted_target(self):
        path = self.dir / 'sticky.pdf'
        document_pdf(path, [{} for number in range(6)] + [{'texts': [
            {'at': (40, 60), 'text': 'A useful formula needs explanation.'}],
            'marks': [{'phrases': ['A useful formula']}],
            'notes': [{'at': (100, 60), 'text': '我需要掌握吗？'}]}])
        bundle, _ = self.extract(path)
        note = next(x for x in bundle["records"] if x["comment"] == "我需要掌握吗？")
        self.assertIsNone(note["target_id"])
        self.assertEqual(note["anchor"]["status"], "spatial_candidate")
        self.assertTrue(note["anchor"]["candidates"])
        self.assertEqual(note["page"], 7)

    def test_duplicate_cross_channel_mark_preserves_both_provenances(self):
        path = self.pdf()
        writer = PdfWriter(clone_from=path)
        rectangle = text_rect('First highlighted phrase.', (40, 60), 'First highlighted phrase.')
        embedded = {"schema_version": 1, "marks": [{"id": "duplicate", "style": "highlight", "page": 1,
                    "text": "First highlighted phrase.", "quads": [[value / 500 for value in rectangle]], "color": "yellow"}],
                    "comments": [], "notes": []}
        writer.add_attachment('scholarseed-annotations.json', json.dumps(embedded).encode())
        dest = self.dir / "duplicate.pdf"
        writer.write(dest)
        bundle, _ = self.extract(dest)
        self.assertEqual(len(bundle["records"]), 1)
        self.assertEqual({x["channel"] for x in bundle["records"][0]["source_refs"]}, {"pdf_annotation", "embedded_mark"})
        self.assertEqual(bundle["records"][0]["comment"], "Need evidence?")

    def test_explicit_native_reply_is_linked_to_mark(self):
        path = self.pdf()
        writer = PdfWriter(clone_from=path)
        page = writer.pages[0]
        note = Text(rect=(210, 425, 230, 445), text='Reply to mark')
        note[NameObject('/IRT')] = page['/Annots'][0]
        writer.add_annotation(page, note)
        dest = self.dir / "reply.pdf"
        writer.write(dest)
        bundle, _ = self.extract(dest)
        note = next(x for x in bundle["records"] if x["comment"] == "Reply to mark")
        self.assertEqual(note["anchor"]["status"], "explicit")
        self.assertEqual(next(x for x in bundle["records"] if x["id"] == note["target_id"])["kind"], "highlight")

    def test_same_first_quad_does_not_merge_different_multiline_ranges(self):
        path = self.pdf(native=False)
        writer = PdfWriter(clone_from=path)
        first, second, third = [text_rect(text, (40, top), text) for top, text in (
            (60, 'First highlighted phrase.'), (90, 'Second line of the claim.'), (130, 'Unrelated paragraph.'))]
        markup(writer, writer.pages[0], [first, second])
        embedded = {"schema_version": 1, "marks": [{"id": "different-range", "style": "highlight", "page": 1,
                    "text": "First highlighted phrase.\nSecond line of the claim.",
                    "quads": [[value / 500 for value in rectangle] for rectangle in (first, third)]}], "comments": [], "notes": []}
        writer.add_attachment('scholarseed-annotations.json', json.dumps(embedded).encode())
        dest = self.dir / "different-ranges.pdf"
        writer.write(dest)
        bundle, _ = self.extract(dest)
        self.assertEqual(len(bundle["records"]), 2)

    def test_duplicate_embedded_ids_do_not_create_ambiguous_comment_links(self):
        data = {"schema_version": 1, "marks": [
            {"id": "same", "style": "highlight", "page": 1, "text": "First", "quads": []},
            {"id": "same", "style": "highlight", "page": 1, "text": "Second", "quads": []}],
            "comments": [{"id": "reply", "mark_id": "same", "body": "Which one?"}], "notes": []}
        bundle, _ = self.extract(self.pdf(data, native=False))
        self.assertEqual(len({x["id"] for x in bundle["records"]}), 3)
        reply = next(x for x in bundle["records"] if x["comment"] == "Which one?")
        self.assertIsNone(reply["target_id"])
        self.assertTrue(any(x["code"] == "ambiguous_mark_id" for x in bundle["coverage"]["warnings"]))

    def test_external_note_preserves_chinese_text_and_line_source(self):
        note = self.dir / "thoughts.md"
        note.write_text("# 我的疑问\n\n可能可以用于我的实验，但尚未验证。\n", encoding="utf-8")
        bundle, _ = self.extract(self.pdf(), "--notes", note)
        notes = [x for x in bundle["records"] if x["kind"] == "note"]
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["text"], note.read_text())
        self.assertEqual(notes[0]["source_refs"][0]["line_start"], 1)
        self.assertEqual(notes[0]["anchor"]["status"], "document")

    def test_unknown_attachment_is_inventory_gap_not_absence(self):
        path = self.pdf(native=False)
        writer = PdfWriter(clone_from=path)
        writer.add_attachment('other-app-notes.json', b'{"personal_notes":["not parsed"]}')
        dest = self.dir / "unknown.pdf"
        writer.write(dest)
        bundle, _ = self.extract(dest)
        self.assertEqual(bundle["attachments"][0]["status"], "unsupported")
        self.assertTrue(any(x["code"] == "unsupported_attachment" for x in bundle["coverage"]["warnings"]))

    def test_malformed_supported_attachment_is_reported(self):
        path = self.pdf(native=False)
        writer = PdfWriter(clone_from=path)
        writer.add_attachment('scholarseed-annotations.json', b'{not json')
        dest = self.dir / "malformed.pdf"
        writer.write(dest)
        bundle, _ = self.extract(dest)
        self.assertEqual(bundle["attachments"][0]["status"], "error")
        self.assertTrue(any(x["code"] == "attachment_parse_error" for x in bundle["coverage"]["warnings"]))

    def test_unknown_schema_version_is_not_silently_parsed(self):
        bundle, _ = self.extract(self.pdf({"schema_version": 999, "marks": [], "notes": []}, native=False))
        self.assertEqual(bundle["attachments"][0]["status"], "unsupported")

    def test_same_text_on_different_pages_is_not_deduplicated(self):
        path = self.dir / "repeat.pdf"
        document_pdf(path, [{'texts': [{'at': (40, 60), 'text': 'Repeated phrase'}],
                            'marks': [{'phrases': ['Repeated phrase']}]}
                           for number in range(2)])
        bundle, _ = self.extract(path)
        self.assertEqual(len(bundle["records"]), 2)
        self.assertEqual({x["page"] for x in bundle["records"]}, {1, 2})

    def test_invalid_embedded_page_is_preserved_as_unanchored(self):
        data = {"schema_version": 1, "marks": [{"id": "bad-page", "style": "highlight", "page": 99,
                "text": "Keep this quotation", "quads": []}], "comments": [], "notes": []}
        bundle, _ = self.extract(self.pdf(data, native=False))
        record = bundle["records"][0]
        self.assertEqual(record["text"], "Keep this quotation")
        self.assertIsNone(record["page"])
        self.assertEqual(record["anchor"]["status"], "unanchored")

    def test_visual_observations_are_preserved_as_distinct_evidence(self):
        path = self.pdf(native=False)
        visual = self.dir / "visual.json"
        visual.write_text(json.dumps({"schema_version": 1, "reviewed_pages": [1], "observations": [
            {"id": "v1", "page": 1, "kind": "note", "text": "疑似手写问题", "confidence": "low"}
        ]}, ensure_ascii=False))
        bundle, _ = self.extract(path, "--visual", visual)
        record = next(x for x in bundle["records"] if x["source"] == "visual")
        self.assertEqual(record["confidence"], "low")
        self.assertEqual(bundle["coverage"]["channels"]["visual"]["status"], "reviewed")
        self.assertEqual(bundle["coverage"]["channels"]["visual"]["review_file"], str(visual.resolve()))

    def test_extraction_does_not_modify_input_and_ids_are_repeatable(self):
        path = self.pdf()
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        first, _ = self.extract(path)
        second, _ = self.extract(path)
        self.assertEqual(before, hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual([x["id"] for x in first["records"]], [x["id"] for x in second["records"]])

    def test_output_collision_does_not_overwrite_existing_file(self):
        path = self.pdf()
        out = self.dir / "existing"
        out.mkdir()
        original = out / "bundle.json"
        original.write_text("my existing notes")
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/extract_pdf.py"), str(path), "--out-dir", str(out)], capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(original.read_text(), "my existing notes")


if __name__ == "__main__":
    unittest.main()
