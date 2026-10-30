"""PDF body selection is applied before expensive page layout."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pdf_fixture

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import pdfscope  # noqa: E402 - exercise the standalone skill after its path bootstrap
from paper_source_parser import (  # noqa: E402 - same standalone skill bootstrap
    Cleaner,
    parse_source,
)

LIB = Path(__file__).resolve().parents[1] / "lib"


class ScopeTest(unittest.TestCase):
    def test_unclosed_math_has_bounded_runtime(self):
        code = "from paper_source_parser import Cleaner; Cleaner().clean('$unclosed ' + r'\\alpha ' * 45)"
        subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; sys.path.insert(0, " + repr(str(LIB)) + "); " + code,
            ],
            timeout=3,
            check=True,
            capture_output=True,
        )

    def test_math_preserves_escape_parity_and_display_delimiters(self):
        cleaner = Cleaner()
        source = r"Before \\$^{*}$ and $x+\alpha$; \(y\) and \[z\] and $$q$$. Cost \$5. Tail."
        text = cleaner.restore(cleaner.clean(source))
        for value in [r"$^{*}$", r"$x+\alpha$", r"\(y\)", r"\[z\]", "$$q$$", "$5", "Tail."]:
            self.assertIn(value, text)

    def parse_pdf(self, count, boundary=None, reference_prose=False, entries_on_next_page=False):
        with tempfile.TemporaryDirectory() as folder:
            doc = pdf_fixture.open()
            for i in range(1, count + 1):
                page = doc.new_page(width=600, height=800)
                page.insert_text((50, 20), "Repeated journal header.")
                page.insert_text((50, 65), f"Body evidence on original page {i}.")
                if i == boundary:
                    page.insert_text((50, 180), "References")
                if (i == boundary and not entries_on_next_page) or (
                    entries_on_next_page and boundary and i == boundary + 1
                ):
                    page.insert_text((50, 220), "[1] Author A. A scientific method. Journal, 2023.")
                    page.insert_text((50, 250), "[2] Author B. Another method. Journal, 2024.")
                if reference_prose and i == 3:
                    page.insert_text(
                        (50, 180), "References to previous experiments are discussed here."
                    )
            source = Path(folder) / "paper.pdf"
            doc.save(source)
            doc.close()
            return parse_source(source)

    def test_boundary_page_keeps_body_and_skips_appendices(self):
        result = self.parse_pdf(60, boundary=6)
        self.assertEqual(result["selected_pages"], list(range(1, 7)))
        self.assertIn("original page 6", result["sentences"])
        self.assertNotIn("original page 7.", result["sentences"])
        self.assertNotIn("Repeated journal header", result["sentences"])

    def test_reference_entries_on_next_page_confirm_previous_body_end(self):
        result = self.parse_pdf(60, boundary=6, entries_on_next_page=True)
        self.assertEqual(result["selected_pages"], list(range(1, 7)))
        self.assertEqual(result["boundary"]["scanned_pages"], 7)
        self.assertIn("original page 6.", result["sentences"])

    def test_long_body_samples_body_ends_not_document_appendix(self):
        result = self.parse_pdf(80, boundary=55)
        self.assertEqual(result["selected_pages"], list(range(1, 21)) + list(range(36, 56)))
        self.assertNotIn("original page 80", result["sentences"])

    def test_unknown_boundary_uses_first_and_last_twenty(self):
        result = self.parse_pdf(50, reference_prose=True)
        self.assertEqual(result["selected_pages"], list(range(1, 21)) + list(range(31, 51)))

    def test_small_pdf_keeps_all_pages(self):
        self.assertEqual(self.parse_pdf(40)["selected_pages"], list(range(1, 41)))

    def test_reference_contents_and_prose_are_not_boundaries(self):
        self.assertIsNone(
            pdfscope.boundary("Contents\nReferences\n[1] Chapter 2023\n[2] Chapter 2024")
        )
        self.assertIsNone(pdfscope.boundary("Our References are discussed below.\n2023.\n2024."))
        self.assertIsNone(pdfscope.boundary("References\nThe previous research is discussed here."))

    def test_more_than_two_hundred_pages_uses_same_forty_page_budget(self):
        self.assertEqual(pdfscope.page_set(240), list(range(20)) + list(range(220, 240)))

    def test_unknown_boundary_probe_is_bounded_at_two_hundred_pages(self):
        result = self.parse_pdf(220)
        self.assertEqual(result["boundary"]["scanned_pages"], 200)
        self.assertEqual(result["selected_pages"], list(range(1, 21)) + list(range(201, 221)))

    def test_probe_failure_keeps_bounded_layout_fallback(self):
        with patch.object(
            pdfscope.pypdfium2, "PdfDocument", side_effect=ValueError("probe failure")
        ):
            result = self.parse_pdf(45)
        self.assertEqual(result["selected_pages"], list(range(1, 21)) + list(range(26, 46)))
        self.assertEqual(result["status"], "ok")

    def test_supplement_cover_is_a_boundary(self):
        self.assertEqual(
            pdfscope.boundary(
                "Supplementary Materials for\nA Scientific Paper\nMaterials and Methods"
            ),
            "supplement",
        )

    def test_caption_uncertainty_does_not_reject_available_text(self):
        with tempfile.TemporaryDirectory() as folder:
            doc = pdf_fixture.open()
            page = doc.new_page(width=600, height=800)
            page.insert_text((50, 80), "The main experimental finding remains available.")
            page.insert_text((50, 150), "Figure 1. An illustration without detected geometry.")
            source = Path(folder) / "caption.pdf"
            doc.save(source)
            doc.close()
            result = parse_source(source)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["fatal_warnings"], [])
        self.assertIn("main experimental finding", result["sentences"])


if __name__ == "__main__":
    unittest.main()
