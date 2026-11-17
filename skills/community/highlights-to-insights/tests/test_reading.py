"""Reading preparation and assembly must preserve provenance without model calls."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
from pypdf import PdfWriter
from pdf_fixture import document_pdf, text_rect

ROOT = Path(__file__).resolve().parents[1]


class ReadingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="reading-test-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.pdf = self.dir / "paper.pdf"
        self.notes = self.dir / "notes.md"
        self.notes.write_text("A tentative application idea.\n\nA separate unresolved question.\n")
        box = text_rect('Forecast beta.', (40, 100), 'Forecast beta.')
        payload = {"schema_version": 1, "marks": [{"id": "beta", "style": "highlight", "page": 1,
                   "text": "Forecast beta.", "quads": [[value / 500 for value in box]], "anchor_state": "anchored"}],
                   "comments": [{"id": "beta-question", "mark_id": "beta", "body": "Question about beta."}], "notes": []}
        document_pdf(self.pdf, [{'texts': [
            {'at': (40, 60), 'text': 'Forecast alpha.'},
            {'at': (40, 100), 'text': 'Forecast beta.'},
            {'at': (40, 160), 'text': 'Loss = realism + consistency.'}],
            'marks': [{'phrases': ['Forecast alpha.']}],
            'notes': [{'at': (240, 145), 'text': 'Should I implement this?'}]}],
            size=(500, 500), attachments={'scholarseed-annotations.json': json.dumps(payload).encode()})
        self.before = self.pdf.read_bytes()

    def call(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/reading.py"), *map(str, args)], capture_output=True, text=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def prepare(self, name="prepared"):
        out = self.dir / name
        report = self.call("prepare", "--pdf", self.pdf, "--notes", self.notes, "--out-dir", out)
        return json.loads((out / "reading.json").read_text()), out, report

    def draft(self, index):
        signals = [s["id"] for s in index["catalog"] if s["record_ids"]]
        draft = {"title": "A connected literature note", "sections": [{"title": "Mechanism and evidence", "paragraphs": [
            {"text": "This paragraph connects the method to the reading questions.", "source_ids": signals, "identity": "mixed"},
            {"text": "The same source can also support another paragraph.", "source_ids": signals[:1]}
        ]}], "omissions": []}
        path = self.dir / "draft.json"
        path.write_text(json.dumps(draft))
        return draft, path

    def test_preparation_keeps_mixed_sources_but_omits_raw_provenance_from_model_packet(self):
        index, out, report = self.prepare()
        self.assertEqual({p.name for p in out.iterdir()}, {"reading.json", "packet.md"})
        self.assertEqual(len(index["records"]), 5)
        packet = (out / "packet.md").read_text()
        self.assertIn("Should I implement this?", packet)
        self.assertIn("Question about beta.", packet)
        self.assertIn("A separate unresolved question.", packet)
        self.assertNotIn("creationDate", packet)
        self.assertNotIn('"vertices"', packet)
        self.assertTrue(index["lines"])
        self.assertEqual(report["model_calls"], 0)
        self.assertEqual(self.pdf.read_bytes(), self.before)

    def test_reuse_requires_unchanged_inputs_and_prepared_packet(self):
        index, out, _ = self.prepare()
        before = (out / "reading.json").read_bytes()
        report = self.call("prepare", "--pdf", self.pdf, "--notes", self.notes, "--out-dir", out)
        self.assertTrue(report["reused"])
        self.assertEqual(before, (out / "reading.json").read_bytes())
        self.notes.write_text("Changed reading goal.")
        failed = self.call("prepare", "--pdf", self.pdf, "--notes", self.notes, "--out-dir", out, ok=False)
        self.assertIn("changed", failed.stderr.lower())

    def test_tampered_packet_is_not_reused(self):
        _, out, _ = self.prepare()
        (out / "packet.md").write_text("Altered packet")
        failed = self.call("prepare", "--pdf", self.pdf, "--notes", self.notes, "--out-dir", out, ok=False)
        self.assertIn("changed", failed.stderr.lower())

    def test_external_note_passages_keep_actual_file_lines(self):
        index, out, _ = self.prepare()
        notes = [s for s in index["catalog"] if s["kind"] == "external_note"]
        self.assertEqual([s["note_lines"] for s in notes], [{"start": 1, "end": 1}, {"start": 3, "end": 3}])
        result = self.call("show", "--index", out / "reading.json", "--sources", notes[1]["id"])
        self.assertEqual(result["sources"][0]["text"], "A separate unresolved question.")
        self.assertEqual(result["sources"][0]["note_file"], str(self.notes.resolve()))

    def test_comment_crop_includes_candidate_context_not_just_the_note_icon(self):
        index, out, _ = self.prepare()
        comment = next(r for r in index["records"] if r["comment"] == "Should I implement this?")
        source = next(s for s in index["catalog"] if comment["id"] in s["record_ids"])
        self.assertEqual(source["association"], "spatial_candidate")
        self.assertTrue(source["context_ids"])
        destination = self.dir / "crop.png"
        result = self.call("crop", "--index", out / "reading.json", "--source", source["id"], "--out", destination)
        with Image.open(destination) as image:
            self.assertGreater(image.width, 100)
        self.assertGreater(result["clip_pdf_points"][2] - result["clip_pdf_points"][0], 24)
        self.assertEqual(result["association"], "spatial_candidate")
        self.assertEqual(self.pdf.read_bytes(), self.before)

    def test_source_lookup_does_not_guess_unknown_ids(self):
        _, out, _ = self.prepare()
        failed = self.call("show", "--index", out / "reading.json", "--sources", "A999999", ok=False)
        self.assertIn("Unknown source", failed.stderr)

    def test_assembly_preserves_many_to_many_links_and_verbatim_reader_quotes(self):
        index, out, _ = self.prepare()
        draft, path = self.draft(index)
        destination = self.dir / "note"
        self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", destination)
        self.assertEqual({p.name for p in destination.iterdir()}, {"note.md", "source-map.json"})
        text = (destination / "note.md").read_text()
        mapping = json.loads((destination / "source-map.json").read_text())
        self.assertNotIn('<!-- hint:paragraph_id=', text)
        self.assertEqual([paragraph['paragraph_id'] for paragraph in mapping['paragraphs']], ['p01', 'p02'])
        self.assertNotIn("[^", text)
        self.assertEqual(mapping["note"]["sha256"], hashlib.sha256(text.encode()).hexdigest())
        entry = next(s for s in mapping["entries"] if s["id"] == draft["sections"][0]["paragraphs"][0]["source_ids"][0])
        self.assertEqual(entry["used_in"], ["p01", "p02"])
        quotes = {s["reader_source_quote"] for s in mapping["entries"] if s.get("reader_source_quote")}
        self.assertIn("Should I implement this?", quotes)
        self.assertIn("A tentative application idea.", quotes)
        self.assertTrue(all(r["source_refs"] for r in mapping["records"]))
        self.assertEqual(mapping["coverage"]["channels"]["visual"]["status"], "pending")
        for p in mapping["paragraphs"]:
            span = p["markdown_lines"]
            actual = "\n".join(text.splitlines()[span["start"] - 1:span["end"]])
            self.assertEqual(hashlib.sha256(actual.encode()).hexdigest(), p["text_sha256"])

    def test_unused_reading_signals_warn_without_an_omission_reason(self):
        index, out, _ = self.prepare()
        draft, path = self.draft(index)
        draft["sections"][0]["paragraphs"] = draft["sections"][0]["paragraphs"][:1]
        missing = draft["sections"][0]["paragraphs"][0]["source_ids"].pop()
        path.write_text(json.dumps(draft))
        dest = self.dir / "note-with-warning"
        result = self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", dest)
        self.assertIn("unaccounted_reading_signals", [warning["code"] for warning in result["warnings"]])
        self.assertTrue((dest / "note.md").exists())
        draft["omissions"] = [{"source_id": missing, "reason": "Outside the selected reading focus."}]
        path.write_text(json.dumps(draft))
        self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", self.dir / "note-with-reason")

    def test_assembly_rejects_invented_source_and_does_not_overwrite_outputs(self):
        index, out, _ = self.prepare()
        draft, path = self.draft(index)
        draft["sections"][0]["paragraphs"][0]["source_ids"].append("invented")
        path.write_text(json.dumps(draft))
        failed = self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", self.dir / "invalid", ok=False)
        self.assertIn("Unknown source", failed.stderr)
        draft["sections"][0]["paragraphs"][0]["source_ids"].pop()
        path.write_text(json.dumps(draft))
        dest = self.dir / "valid"
        self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", dest)
        before = (dest / "note.md").read_bytes()
        self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", dest, ok=False)
        self.assertEqual((dest / "note.md").read_bytes(), before)

    def test_changed_original_is_rejected_before_assembly(self):
        index, out, _ = self.prepare()
        _, path = self.draft(index)
        self.notes.write_text("Different note now.")
        failed = self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", self.dir / "changed", ok=False)
        self.assertIn("changed", failed.stderr.lower())

    def test_reader_code_change_invalidates_prepared_reuse(self):
        copied = self.dir / "worker"
        copied.mkdir()
        for name in ("reading.py", "reading_pipeline.py", "pdf_sources.py", "packet_selection.py", "paper_scope.py", "packet_format.py", "object_policy.py", "source_ids.py"):
            shutil.copy2(ROOT / "scripts" / name, copied / name)
        shutil.copytree(ROOT / "cpes_machine", self.dir / "cpes_machine", ignore=shutil.ignore_patterns("__pycache__"))
        out = self.dir / "copied-reading"
        command = [sys.executable, str(copied / "reading.py"), "prepare", "--pdf", str(self.pdf), "--out-dir", str(out)]
        first = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        with (copied / "pdf_sources.py").open("a") as stream:
            stream.write("\n# Extractor revision changes prepared identity.\n")
        again = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(again.returncode, 0)
        self.assertIn("code changed", again.stderr.lower())

    def test_trailing_paragraph_whitespace_does_not_break_source_hashes(self):
        index, out, _ = self.prepare()
        draft, path = self.draft(index)
        draft["sections"][0]["paragraphs"][0]["text"] += "\n"
        path.write_text(json.dumps(draft))
        dest = self.dir / "whitespace"
        self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", dest)
        text = (dest / "note.md").read_text().splitlines()
        mapping = json.loads((dest / "source-map.json").read_text())
        for p in mapping["paragraphs"]:
            scope = p["markdown_lines"]
            value = "\n".join(text[scope["start"] - 1:scope["end"]])
            self.assertEqual(hashlib.sha256(value.encode()).hexdigest(), p["text_sha256"])

    def test_whitespace_only_separator_cannot_hide_an_extra_paragraph(self):
        index, out, _ = self.prepare()
        draft, path = self.draft(index)
        draft["sections"][0]["paragraphs"][0]["text"] = "One paragraph.\n \nA second paragraph."
        path.write_text(json.dumps(draft))
        destination = self.dir / "bad-paragraph"
        self.call("assemble", "--index", out / "reading.json", "--draft", path, "--out-dir", destination, ok=False)
        self.assertFalse(destination.exists())

    def test_crop_retains_real_highlight_pixels_on_a_rotated_page(self):
        rotated = self.dir / "rotated.pdf"
        writer = PdfWriter(clone_from=self.pdf)
        writer.pages[0].rotate(90)
        writer.write(rotated)
        out = self.dir / "rotated-reading"
        self.call("prepare", "--pdf", rotated, "--out-dir", out)
        index = json.loads((out / "reading.json").read_text())
        mark = next(r for r in index["records"] if r["source"] == "pdf_annotation" and r["kind"] == "highlight")
        source = next(s for s in index["catalog"] if mark["id"] in s["record_ids"])
        png = self.dir / "rotated-crop.png"
        self.call("crop", "--index", out / "reading.json", "--source", source["id"], "--out", png)
        with Image.open(png) as image, image.convert('RGB') as bitmap:
            self.assertGreater(bitmap.height, bitmap.width)
            samples = bitmap.tobytes()
            yellow = sum(1 for red, green, blue in zip(samples[0::3], samples[1::3], samples[2::3])
                         if red > 180 and green > 180 and blue < 160)
        self.assertGreater(yellow, 20)

    def test_local_lookup_marks_truncation_explicitly(self):
        index, out, _ = self.prepare()
        source = next(s for s in index["catalog"] if s["kind"] == "external_note")
        result = self.call("show", "--index", out / "reading.json", "--sources", source["id"], "--max-chars", 8)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["sources"][0]["text"], "A tentat")

    def test_formula_comment_crop_keeps_the_left_hand_side(self):
        paper = self.dir / 'formula.pdf'
        document_pdf(paper, [{} for number in range(6)] + [{'texts': [
            {'at': (310, 585), 'text': 'Loss = realism + consistency.'}],
            'notes': [{'at': (500, 585), 'text': '我需要掌握吗？'}]}], size=(600, 800))
        out = self.dir / "dgmr-reading"
        self.call("prepare", "--pdf", paper, "--out-dir", out)
        index = json.loads((out / "reading.json").read_text())
        comment = next(r for r in index["records"] if r["comment"] == "我需要掌握吗？")
        source = next(s for s in index["catalog"] if comment["id"] in s["record_ids"])
        lhs = min(line["rect"][0] for line in index["lines"] if line["page"] == 7 and line["rect"][0] > 300 and 575 < line["rect"][1] < 590)
        result = self.call("crop", "--index", out / "reading.json", "--source", source["id"], "--out", self.dir / "eq2.png")
        self.assertLessEqual(result["clip_pdf_points"][0], lhs)


if __name__ == "__main__":
    unittest.main()
