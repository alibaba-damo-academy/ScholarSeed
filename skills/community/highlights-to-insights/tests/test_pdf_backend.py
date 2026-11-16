"""PDF source and pipeline contracts without a MuPDF fixture dependency."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, TextStringObject

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))


def make_pdf(path, rotation=0, shifted=False):
    writer = PdfWriter()
    page = writer.add_blank_page(300, 400)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 10 Tf 40 300 Td (ALPHA BETA) Tj 0 -20 Td (GAMMA DELTA) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    if shifted:
        page.mediabox.lower_left = (10, 20)
        page.mediabox.upper_right = (310, 420)
    page.cropbox.lower_left = (10, 20)
    page.cropbox.upper_right = (290, 390)
    page.rotate(rotation)
    points = [75, 310, 104, 310, 75, 298, 104, 298, 40, 290, 79, 290, 40, 278, 79, 278]
    mark = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Highlight'), NameObject('/NM'): TextStringObject('mark-1'), NameObject('/Rect'): ArrayObject([FloatObject(v) for v in (40, 278, 104, 310)]), NameObject('/QuadPoints'): ArrayObject([FloatObject(v) for v in points]), NameObject('/Contents'): TextStringObject('A real question')})
    writer.add_annotation(page, mark)
    reply = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Text'), NameObject('/Rect'): ArrayObject([FloatObject(v) for v in (150, 280, 170, 300)]), NameObject('/Contents'): TextStringObject('A reply'), NameObject('/IRT'): page['/Annots'][0]})
    writer.add_annotation(page, reply)
    payload = {'schema_version': 1, 'marks': [{'id': 'app-mark', 'page': 1, 'style': 'underline', 'text': 'GAMMA', 'quads': [[.1, .2, .3, .25]]}], 'comments': [{'id': 'app-comment', 'mark_id': 'app-mark', 'body': 'App question'}], 'notes': []}
    writer.add_attachment('scholarseed-annotations.json', json.dumps(payload).encode())
    writer.write(path)


class PdfBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_highlights_replies_and_attachments_on_rotated_cropped_pages(self):
        from pdf_sources import build_bundle
        for rotation in (0, 90, 180, 270):
            for shifted in (False, True):
                with self.subTest(rotation=rotation, shifted=shifted):
                    pdf = self.root / f'{rotation}-{shifted}.pdf'
                    make_pdf(pdf, rotation, shifted)
                    bundle = build_bundle(pdf)
                    native = [r for r in bundle['records'] if r['source'] == 'pdf_annotation']
                    self.assertEqual(native[0]['text'], 'BETA\nGAMMA')
                    self.assertEqual(native[0]['comment'], 'A real question')
                    self.assertEqual(native[1]['target_id'], native[0]['id'])
                    self.assertEqual(native[1]['anchor']['status'], 'explicit')
                    self.assertEqual(native[0]['rects'][0], [65.0, 80.0, 94.0, 92.0])
                    app = [r for r in bundle['records'] if r['source'].startswith('embedded')]
                    self.assertEqual(app[1]['target_id'], app[0]['id'])
                    self.assertEqual(bundle['pages'][0]['width'], 280)
                    self.assertEqual(bundle['pages'][0]['height'], 370)

    def test_prepare_request_assemble_and_reuse_without_mupdf(self):
        from reading_pipeline import prepare, assemble
        from cpes_machine.writer import prepare_request, load_request
        pdf = self.root / 'paper.pdf'
        make_pdf(pdf)
        before = pdf.read_bytes()
        notes = self.root / 'notes.md'
        notes.write_text('Personal question.\n\nA tentative idea.\n')
        prepared = self.root / 'reading'
        prepare(pdf, prepared, [notes])
        index = json.loads((prepared / 'reading.json').read_text())
        self.assertNotIn('pymupdf_version', index)
        self.assertIn('pdfplumber', index['engines'])
        request = self.root / 'request.json'
        prepare_request(prepared / 'reading.json', request, language='English')
        frozen = load_request(request)
        self.assertEqual(frozen['language'], 'English')
        sources = [s['id'] for s in index['catalog']]
        draft = {'title': 'Paper note', 'sections': [{'title': '', 'paragraphs': [{'text': 'The paper addresses a forecasting problem.', 'source_ids': sources, 'identity': 'mixed', 'explanation': ''}]}], 'omissions': []}
        draft_path = self.root / 'draft.json'
        draft_path.write_text(json.dumps(draft))
        assemble(prepared / 'reading.json', draft_path, self.root / 'final')
        mapping = json.loads((self.root / 'final/source-map.json').read_text())
        self.assertEqual(mapping['schema_version'], 2)
        self.assertTrue(all('excerpt' in entry for entry in mapping['entries']))
        self.assertEqual(mapping['paragraphs'][0]['source_ids'], sources)
        self.assertTrue(prepare(pdf, prepared, [notes])['reused'])
        self.assertEqual(pdf.read_bytes(), before)

    def test_rotated_crop_and_contact_sheet_render_without_mupdf(self):
        from reading_pipeline import prepare, crop
        from render_pages import render
        pdf = self.root / 'rotated.pdf'
        make_pdf(pdf, 90, True)
        prepared = self.root / 'reading'
        prepare(pdf, prepared)
        png = self.root / 'crop.png'
        result = crop(prepared / 'reading.json', png, page_number=1, rect=[60, 70, 110, 120], dpi=72, padding=0)
        self.assertTrue(result['annotations_rendered'])
        with Image.open(png) as image:
            self.assertEqual(image.size, (50, 50))
        manifest = render(pdf, self.root / 'render', 'all', dpi=72, overview=True)
        with Image.open(manifest['pages'][0]['path']) as image:
            self.assertEqual(image.size, (370, 280))
        with self.assertRaises(ValueError):
            render(pdf, self.root / 'render', 'all', dpi=72, overview=True)

    def test_cli_works_from_unrelated_working_directory(self):
        pdf = self.root / 'paper.pdf'
        make_pdf(pdf)
        moved = self.root / 'moved-skill'
        shutil.copytree(ROOT, moved, ignore=shutil.ignore_patterns('.git', '__pycache__', 'tests'))
        result = subprocess.run([sys.executable, str(moved / 'scripts/reading.py'), 'prepare', '--pdf', str(pdf), '--out-dir', str(self.root / 'reading')], cwd=self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])

    def test_optional_cpes_native_export_and_figure_profiles(self):
        from cpes_format_converter.native import export_native_context
        from cpes_format_converter.visual_input import extract_figure_image
        pdf = self.root / 'text.pdf'
        make_pdf(pdf)
        result = export_native_context(pdf, self.root, 'bound-source')
        self.assertEqual(result['mode'], 'native_only')
        self.assertGreater(result['line_count'], 0)
        writer = PdfWriter()
        page = writer.add_blank_page(300, 400)
        bitmap = DecodedStreamObject()
        bitmap.set_data(bytes([255, 0, 0] * 4))
        bitmap.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                       NameObject('/Width'): FloatObject(2), NameObject('/Height'): FloatObject(2),
                       NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): FloatObject(8)})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/Im1'): writer._add_object(bitmap)})})
        content = DecodedStreamObject()
        content.set_data(b'q 100 0 0 50 50 200 cm /Im1 Do Q')
        page[NameObject('/Contents')] = writer._add_object(content)
        image_pdf = self.root / 'image.pdf'
        writer.write(image_pdf)
        for profile in ('deep', 'fast'):
            with self.subTest(profile=profile):
                output = self.root / f'{profile}.png'
                visual = extract_figure_image(image_pdf, {'page_number': 1, 'width': 600, 'height': 800}, [100, 300, 300, 400], output, profile=profile)
                self.assertEqual(visual['route'], 'bitmap-original' if profile == 'deep' else 'bitmap-crop')
                self.assertEqual(visual['native_text'], [])
                with Image.open(output) as image:
                    self.assertEqual(image.getpixel((image.width//2, image.height//2))[:3], (255, 0, 0))


if __name__ == '__main__':
    unittest.main()
