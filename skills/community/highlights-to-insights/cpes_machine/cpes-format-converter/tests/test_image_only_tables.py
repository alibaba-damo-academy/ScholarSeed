"""Image-only Table extraction keeps visual evidence without structure models."""
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter.worker import build_payload, convert_document, confirmed_table_numbers
from cpes_format_converter.extract import normalize_pages
from cpes_format_converter.direct_tables import publish_tables


def scan_page(number=1):
    return {'parsing_res_list': [
        {'block_label': 'table_title', 'block_bbox': [50,100,700,180],
         'block_content': f'Table {number}: Results'},
        {'block_label': 'table', 'block_bbox': [50,200,700,500], 'block_content': ''}]}


class ImageOnlyTablesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def pdf(self, scanned=False):
        pdf = self.root/'paper.pdf'
        pages = [{'rectangles': [(30, 30, 50, 50)]} if scanned else
                 {'texts': [{'at': (30, 80), 'text': f'Table {number}: Results'}]}
                 for number in range(1, 4)]
        document_pdf(pdf, pages)
        return pdf

    def test_native_target_publishes_crop_without_structure_or_tex(self):
        class Backend:
            def layout(self, image):
                return {'boxes': [
                    {'label':'table_title','coordinate':[50,100,700,180]},
                    {'label':'table','coordinate':[50,200,700,500]}]}
            def structured(self, *args):
                raise AssertionError('Image-only native Tables must skip structure inference')
            def scan(self, image):
                raise AssertionError('Native pages must not use OCR')
        pdf = self.pdf()
        info = {}
        pages = convert_document(pdf, {'table'}, Backend(), table_numbers=['2'],
                                 search_info=info, image_only=True)
        self.assertEqual(info['processed_pages'], [2])
        self.assertEqual(info['matched_pages'], {'2':[2]})
        self.assertTrue(info['stopped_early'])
        (self.root/'table-cards').mkdir()
        with patch('cpes_format_converter.direct_tables.table_rows', side_effect=AssertionError('No HTML parsing')):
            result = publish_tables(pdf, normalize_pages(pages, allow_sparse=True), self.root,
                                    ['2'], image_only=True)
        self.assertEqual(result['status'], 'success')
        item = result['tables'][0]
        self.assertEqual(item['metadata']['page_number'], 2)
        self.assertNotIn('rows', item['metadata'])
        self.assertNotIn('columns', item['metadata'])
        directory = self.root/'table-cards/table-2'
        self.assertEqual({p.name for p in directory.iterdir()}, {'table.png','caption.md'})
        self.assertEqual((directory/'caption.md').read_text().strip(), 'Table 2: Results')
        with Image.open(directory/'table.png') as image:
            self.assertEqual(image.size, (650,300))

    def test_scan_disables_table_model_and_confirms_empty_content(self):
        calls = []
        class Pipeline:
            def __init__(self, **options):
                if options['use_table_recognition']:
                    raise AssertionError('Scan must not initialize table recognition')
            def predict(self, input):
                calls.append(input)
                return [scan_page(len(calls))]
        paddleocr = types.SimpleNamespace(PPStructureV3=Pipeline, __version__='test')
        paddle = types.SimpleNamespace(__version__='test', device=types.SimpleNamespace(get_device=lambda:'cpu'))
        with patch.dict(sys.modules, {'paddleocr':paddleocr, 'paddle':paddle}), \
             patch.dict(os.environ, {'CPES_PADDLE_LOCK':str(self.root/'paddle.lock')}), \
             patch('cpes_format_converter.worker.importlib.metadata.version', return_value='test'):
            payload = build_payload(self.pdf(scanned=True), {'table'}, table_numbers=['1'], image_only=True)
        self.assertFalse(payload['parameters']['use_table_recognition'])
        self.assertEqual(payload['engine']['ocr_pages'], [1])
        self.assertEqual(payload['search']['matched_pages'], {'1':[1]})
        self.assertTrue(payload['search']['stopped_early'])

    def test_confirmation_requires_caption_and_visible_table_region(self):
        raw = scan_page()
        raw.update(page_index=0, width=800, height=800)
        page = normalize_pages([raw])[0]
        self.assertEqual(confirmed_table_numbers(page, image_only=True), ['1'])
        self.assertEqual(confirmed_table_numbers(page), [])
        page['regions'][0]['raw_label'] = 'text'
        self.assertEqual(confirmed_table_numbers(page, image_only=True), [])
        page['regions'][0]['raw_label'] = 'table_title'
        page['regions'][0]['bbox_pixels'] = [900,100,1100,180]
        page['regions'][1]['bbox_pixels'] = [900,200,1100,500]
        self.assertEqual(confirmed_table_numbers(page, image_only=True), [])
        (self.root/'table-cards').mkdir()
        result = publish_tables(self.pdf(), [page], self.root, image_only=True)
        self.assertEqual(result['count'], 0)
        self.assertEqual(result['issues'][0]['code'], 'table_region_unavailable')
