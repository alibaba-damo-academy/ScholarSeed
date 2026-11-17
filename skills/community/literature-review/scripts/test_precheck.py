import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from docx import Document
from PIL import Image
from precheck import diagnostic_notes, inspect_source, precheck


class PrecheckTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="slr-precheck-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "v1.md"
        self.destination = self.root / "trial.docx"

    def inspect(self, text, format="markdown"):
        self.source.write_text(text, encoding="utf-8")
        before = self.source.read_bytes()
        report = inspect_source(self.source, format, self.destination)
        self.assertEqual(self.source.read_bytes(), before)
        return report

    def test_docx_trial_uses_real_converter_without_editing_source(self):
        Image.new("RGB", (80, 40), "white").save(self.root / "image.png")
        report = self.inspect(
            "# Review\n\nFormula $x_i^2$.\n\n"
            "| A | B |\n| --- | --- |\n| x | y |\n\n"
            "![Image](image.png)\n",
            "docx",
        )
        self.assertEqual(report["status"], "SUCCESS", report)
        self.assertEqual(report["trial_export"], "SUCCESS")
        document = Document(self.destination)
        self.assertEqual(len(document.tables), 1)
        self.assertEqual(len(document.inline_shapes), 1)
        self.assertEqual(len(document.element.xpath("//m:oMath")), 1)
        self.assertEqual(diagnostic_notes(report, "chinese"), "")

    def test_missing_image_has_source_line_and_plain_language_note(self):
        report = self.inspect("# Review\n\n![Image](missing.png)\n", "docx")
        self.assertEqual(report["issues"][0]["code"], "missing_image")
        self.assertEqual(report["issues"][0]["source_line"], 3)
        self.assertFalse(self.destination.exists())
        notes = diagnostic_notes(report, "chinese")
        self.assertIn("第3行", notes)
        self.assertIn("missing.png", notes)
        with self.assertRaises(json.JSONDecodeError):
            json.loads(notes)

    def test_word_math_limit_is_not_applied_to_markdown(self):
        text = "# Review\n\nUnsupported here $\\unknown{x}$.\n"
        markdown = self.inspect(text)
        word = self.inspect(text, "docx")
        self.assertEqual(markdown["status"], "SUCCESS")
        self.assertEqual(word["issues"][0]["code"], "docx_conversion")
        self.assertEqual(word["issues"][0]["source_line"], 3)
        self.assertIn("unknown", word["issues"][0]["excerpt"])

    def test_unsupported_html_is_located_only_for_docx(self):
        text = "# Review\n\n<aside>Details</aside>\n"
        self.assertEqual(self.inspect(text)["status"], "SUCCESS")
        report = self.inspect(text, "docx")
        self.assertEqual(report["issues"][0]["source_line"], 3)
        self.assertEqual(report["status"], "WARNING")

    def test_duplicate_identifiers_use_publisher_rules(self):
        report = self.inspect("## A {#same}\n\n## B {#same}\n")
        self.assertEqual(report["issues"][0]["code"], "markdown_structure")
        self.assertEqual(report["issues"][0]["source_line"], 3)

    def test_valid_native_figure_is_pending_not_a_broken_image(self):
        (self.root / "tree.tex").write_text("\\begin{forest} [Root [Leaf]] \\end{forest}")
        report = self.inspect("![Tree](tree.tex)\n", "docx")
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["status"], "PARTIAL_SUCCESS")
        self.assertEqual(report["trial_export"], "SKIPPED")
        self.assertFalse(self.destination.exists())
        self.assertEqual(diagnostic_notes(report, "english"), "")

    def test_remote_images_are_not_downloaded(self):
        with patch("socket.create_connection", side_effect=AssertionError("network forbidden")):
            report = self.inspect("![Remote](https://example.invalid/image.png)\n")
        self.assertEqual(report["status"], "PARTIAL_SUCCESS")
        self.assertEqual(report["issues"], [])

    def test_timeout_is_incomplete_and_does_not_generate_model_instructions(self):
        self.source.write_text("# Review\n\nContent.")
        with patch("precheck.subprocess.run", side_effect=subprocess.TimeoutExpired("worker", 2)):
            report = precheck(self.root, self.source, "docx")
        self.assertEqual(report["status"], "TIMEOUT")
        self.assertEqual(diagnostic_notes(report, "english"), "")

    def test_actual_worker_is_bounded_and_uses_the_current_interpreter(self):
        self.source.write_text("# Review\n\nContent $x^2$.")
        report = precheck(self.root, self.source, "docx")
        self.assertEqual(report["status"], "SUCCESS", report)
        self.assertEqual(report["trial_export"], "SUCCESS")
        self.assertTrue(Path(report["report_path"]).is_file())

    def test_worker_failure_is_not_reported_as_a_clean_source(self):
        self.source.write_text("# Review\n\nContent.")
        result = subprocess.CompletedProcess(["worker"], 1, "", "Worker dependency unavailable")
        with patch("precheck.subprocess.run", return_value=result):
            report = precheck(self.root, self.source, "docx")
        self.assertEqual(report["status"], "UNAVAILABLE")
        self.assertTrue(Path(report["error_log"]).is_file())
        self.assertEqual(diagnostic_notes(report, "chinese"), "")

    def test_trial_destination_cannot_overwrite_the_source(self):
        self.source.write_text("# Review\n\nContent.")
        original = self.source.read_bytes()
        with self.assertRaises(ValueError):
            inspect_source(self.source, "docx", self.source)
        self.assertEqual(self.source.read_bytes(), original)

    def test_worker_accepts_unicode_and_space_paths(self):
        folder = self.root / "含 空格"
        folder.mkdir()
        source = folder / "综述.md"
        source.write_text("# 综述\n\n正文。", encoding="utf-8")
        report = precheck(folder, source, "markdown")
        self.assertEqual(report["status"], "SUCCESS", report)

    def test_real_worker_timeout_is_not_a_success(self):
        self.source.write_text("# Review\n\nContent.")
        report = precheck(self.root, self.source, "docx", timeout_seconds=0.001)
        self.assertEqual(report["status"], "TIMEOUT")
        self.assertEqual(diagnostic_notes(report, "english"), "")

    def test_unlocated_converter_failure_remains_incomplete_not_a_repair_prompt(self):
        with patch("precheck.export", side_effect=ValueError("Unlocated converter failure")):
            report = self.inspect("# Review\n\nContent.", "docx")
        self.assertEqual(report["status"], "PARTIAL_SUCCESS")
        self.assertEqual(report["trial_export"], "FAILED")
        self.assertIn("conversion_error", report)
        self.assertEqual(diagnostic_notes(report, "english"), "")


if __name__ == "__main__":
    unittest.main()
