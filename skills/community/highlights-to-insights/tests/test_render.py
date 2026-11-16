"""Behavior tests for visual coverage and read-only PDF rendering."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
from pdf_fixture import document_pdf

ROOT = Path(__file__).resolve().parents[1]


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="render-test-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.pdf = self.dir / "input.pdf"
        document_pdf(self.pdf, [{'texts': [{'at': (40, 60), 'text': f'Evidence on page {number+1}'}],
                                 'marks': [{'phrases': ['Evidence']}] if number == 1 else []}
                                for number in range(3)], size=(400, 600))

    def run_render(self, *args, out=None):
        out = out or self.dir / "rendered"
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/render_pages.py"), str(self.pdf),
                               "--out-dir", str(out), *args], capture_output=True, text=True)
        return proc, out

    def test_selected_pages_are_real_png_images(self):
        proc, out = self.run_render("--pages", "1,3", "--dpi", "96")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual([x["page"] for x in manifest["pages"]], [1, 3])
        for item in manifest["pages"]:
            image = Path(item["path"])
            self.assertTrue(image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            with Image.open(image) as bitmap:
                self.assertGreater(bitmap.width, 400)

    def test_overview_covers_even_unselected_pages(self):
        proc, out = self.run_render("--pages", "2", "--overview")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual(manifest["overview"][0]["pages"], [1, 2, 3])
        self.assertTrue(Path(manifest["overview"][0]["path"]).is_file())
        self.assertEqual(manifest["visual_review_status"], "pending")

    def test_overview_only_does_not_create_unused_full_page_images(self):
        proc, out = self.run_render("--pages", "none", "--overview")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual(manifest["pages"], [])
        self.assertEqual(manifest["overview"][0]["pages"], [1, 2, 3])
        self.assertEqual({p.name for p in out.iterdir()}, {"manifest.json", "overview-001.png"})

    def test_none_without_overview_is_rejected(self):
        proc, out = self.run_render("--pages", "none")
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(out.exists())

    def test_out_of_range_page_fails_before_output_creation(self):
        proc, out = self.run_render("--pages", "4")
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(out.exists())

    def test_zero_page_is_rejected(self):
        proc, _ = self.run_render("--pages", "0")
        self.assertNotEqual(proc.returncode, 0)

    def test_rendering_preserves_original_pdf_hash(self):
        before = hashlib.sha256(self.pdf.read_bytes()).hexdigest()
        proc, _ = self.run_render("--pages", "1", "--overview")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(before, hashlib.sha256(self.pdf.read_bytes()).hexdigest())

    def test_output_collision_does_not_overwrite_prior_image(self):
        out = self.dir / "existing"
        out.mkdir()
        prior = out / "page-0001.png"
        prior.write_bytes(b"keep this artifact")
        proc, _ = self.run_render("--pages", "1", out=out)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(prior.read_bytes(), b"keep this artifact")


if __name__ == "__main__":
    unittest.main()
