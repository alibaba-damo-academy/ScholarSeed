import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import types

import numpy
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_format_converter import cli, worker
from cpes_format_converter.extract import extract_formulas, extract_text, normalize_pages
from cpes_format_converter.native import bind_lines, native_lines
from cpes_format_converter.paddle_backend import PaddleBackend
from cpes_format_converter.pdf import PDFDocument, render_page


def text_page(writer, width, height, text, origin):
    page = writer.add_blank_page(width=width, height=height)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({
        NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    escaped = [line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
               for line in text.split('\n')]
    commands = [f'BT /F1 11 Tf 15 TL {origin[0]} {height-origin[1]} Td']
    commands.extend(f'({line}) Tj T*' for line in escaped)
    commands.append('ET')
    content = DecodedStreamObject()
    content.set_data('\n'.join(commands).encode('ascii'))
    page[NameObject('/Contents')] = writer._add_object(content)
    return page


class Backend:
    def __init__(self):
        self.calls = []

    def layout(self, image):
        self.calls.append('layout')
        return {'boxes': [{'label': 'text', 'score': .99,
                           'coordinate': [0, 0, 1190, 1684]}]}

    def scan(self, image):
        self.calls.append('ocr')
        return {'parsing_res_list': [{'block_label': 'text',
                'block_bbox': [20, 20, 100, 50], 'block_content': 'Scanned line'}]}

    def structured(self, image, layout, lines, domains):
        return {}, []


class NativeRoutingTests(unittest.TestCase):
    def make_pdf(self, root, kinds):
        path = root / 'source.pdf'
        writer = PdfWriter()
        for kind in kinds:
            if kind == 'native':
                text_page(writer, 595, 842, 'Original hyphen-\nated text', (72, 72))
            elif kind == 'scan':
                with Image.new('RGB', (595, 842), 'white') as image, io.BytesIO() as stream:
                    ImageDraw.Draw(image).text((72, 72), 'Scanned line', fill='black')
                    image.save(stream, format='PDF')
                    writer.add_page(PdfReader(stream).pages[0])
            else:
                writer.add_blank_page(width=595, height=842)
        writer.write(path)
        return path

    def test_native_pages_never_call_ocr_and_keep_exact_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend = Backend()
            pages = worker.convert_document(self.make_pdf(root, ['native']), {'text'}, backend)
            self.assertEqual(backend.calls, ['layout'])
            self.assertEqual(pages[0]['extraction_method'], 'native')
            self.assertEqual([x['text'] for x in pages[0]['source_lines']],
                             ['Original hyphen-', 'ated text'])

    def test_mixed_document_routes_per_page_and_preserves_page_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend = Backend()
            raw = worker.convert_document(self.make_pdf(root, ['native', 'scan', 'native']), {'text'}, backend)
            self.assertEqual(backend.calls, ['layout', 'ocr', 'layout'])
            pages = normalize_pages(raw)
            self.assertEqual([p['page_number'] for p in pages], [1, 2, 3])
            self.assertEqual([p['extraction_method'] for p in pages], ['native', 'ocr', 'native'])
            result = extract_text(pages, root, source_hash='abc')
            self.assertEqual(result['status'], 'success')
            body = (root / 'text/document.txt').read_bytes()
            source = json.loads((root / 'text/source.json').read_text())
            self.assertEqual(source['text_sha256'], hashlib.sha256(body).hexdigest())
            self.assertEqual(source['pdf_sha256'], 'abc')
            self.assertEqual([l['line_number'] for l in source['lines']], list(range(1, 6)))
            self.assertEqual([l['page_number'] for l in source['lines']], [1, 1, 2, 3, 3])
            self.assertEqual([l['text'] for l in source['lines']], body.decode().splitlines())
            self.assertTrue(all(l['bbox_pixels'] for l in source['lines']))

    def test_compact_native_source_keeps_control_glyphs_inside_one_line(self):
        from cpes_format_converter.compact import compact_output
        from cpes_format_converter.common import artifact,write_json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);context=root/'native-context';context.mkdir()
            body=context/'document.txt';body.write_text('before\n\f\fmath\nnext\n')
            write_json(context/'source.json',{'lines':[{'line_number':i,'text':t} for i,t in enumerate(['before','\f\fmath','next'],1)]})
            write_json(root/'layout.json',{'pages':[]})
            catalog={'requested_domains':['figure'],'layout':artifact(root/'layout.json',root),
                     'domains':{'figure':{'figures':[]}},'native_context':{'artifacts':[artifact(p,root) for p in context.iterdir()]}}
            compact_output(root,catalog)
            self.assertEqual(body.read_text(),'before\n\f\fmath\nnext\n')
            source=json.loads((context/'source.json').read_text())
            self.assertEqual([r['line_number'] for r in source['lines']],[1,2,3])

    def test_unmatched_native_lines_are_not_lost(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend = Backend()
            backend.layout = lambda image: {'boxes': []}
            raw = worker.convert_document(self.make_pdf(root, ['native']), {'text'}, backend)
            pages = normalize_pages(raw)
            self.assertEqual(len(pages[0]['regions']), 2)
            self.assertEqual('\n'.join(r['content'] for r in pages[0]['regions']),
                             'Original hyphen-\nated text')

    def test_blank_page_needs_no_models(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend = Backend()
            raw = worker.convert_document(self.make_pdf(root, ['blank']), {'text'}, backend)
            self.assertEqual(backend.calls, [])
            self.assertEqual(raw[0]['extraction_method'], 'empty')

    def test_rotated_native_coordinates_match_rendered_page(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'rotated.pdf'
            writer = PdfWriter()
            text_page(writer, 300, 500, 'Rotated text', (40, 60)).rotate(90)
            writer.write(path)
            with PDFDocument(path) as document, render_page(path, 0, scale=2) as image:
                self.assertEqual(image.size, (1000, 600))
                line = native_lines(document[0], image.width, image.height)[0]
                left, top, right, bottom = line['bbox_points']
                expected = ((500-bottom)*2, left*2, (500-top)*2, right*2)
                self.assertEqual(line['text'], 'Rotated text')
                for got, wanted in zip(line['bbox_pixels'], expected):
                    self.assertAlmostEqual(got, wanted, places=4)
                self.assertLess(line['bbox_pixels'][2], image.width)
                self.assertLess(line['bbox_pixels'][3], image.height)

    def test_overlapping_layout_preserves_each_native_line_once(self):
        lines = [{'text': 'kept', 'bbox_pixels': [10, 10, 50, 20], 'source_line_id': 'a'}]
        layout = {'boxes': [{'label': 'text', 'coordinate': [0, 0, 100, 100]},
                            {'label': 'text', 'coordinate': [5, 5, 60, 30]}]}
        blocks = bind_lines(lines, layout)
        self.assertEqual([l['source_line_id'] for b in blocks for l in b['source_lines']], ['a'])

    def test_native_table_adapter_disables_all_ocr_paths(self):
        seen = {}
        class Table:
            def __init__(self, **kwargs):
                seen['init'] = kwargs
            def predict(self, image, **kwargs):
                assert isinstance(kwargs['overall_ocr_res']['doc_preprocessor_res']['output_img'], numpy.ndarray)
                seen['predict'] = kwargs
                return [{'table_res_list': [{'pred_html': '<table><tr><td>Original</td></tr></table>'}]}]
        backend = PaddleBackend({'device': 'cpu'})
        layout = {'boxes': [{'label': 'table', 'coordinate': [0, 0, 100, 100]}]}
        lines = [{'text': 'Original', 'bbox_pixels': [10, 10, 50, 20]}]
        with patch.dict(sys.modules, {'paddleocr': types.SimpleNamespace(TableRecognitionPipelineV2=Table)}):
            from PIL import Image
            with tempfile.TemporaryDirectory() as temp:
                image=Path(temp)/'native-table.png';Image.new('RGB',(100,100),'white').save(image)
                values, issues = backend.structured(str(image), layout, lines, {'table'})
        self.assertEqual(issues, [])
        self.assertIn('Original', values[0])
        self.assertFalse(seen['init']['use_ocr_model'])
        for key in ('use_ocr_model', 'use_ocr_results_with_table_cells', 'use_table_orientation_classify'):
            self.assertFalse(seen['predict'][key])
        self.assertEqual(seen['predict']['overall_ocr_res']['rec_texts'], ['Original'])
        self.assertIsNone(backend.scan_model)

    def test_structured_failures_do_not_publish_native_math_as_latex(self):
        backend = PaddleBackend({'device': 'cpu'})
        backend.formulas = lambda *args: (_ for _ in ()).throw(RuntimeError('model unavailable'))
        layout = {'boxes': [{'label': 'formula', 'coordinate': [0, 0, 100, 100]}]}
        values, issues = backend.structured('unused.png', layout, [], {'formula'})
        self.assertEqual(values, {0: ''})
        self.assertEqual(issues[0]['domain'], 'formula')
        self.assertEqual(issues[0]['code'], 'structured_recognition_failed')

    def test_empty_numbered_formula_retains_failure_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = self.make_pdf(root, ['native'])
            pages = normalize_pages([{'page_index': 0, 'width': 1190, 'height': 1684,
                'parsing_res_list': [
                    {'block_label': 'formula', 'block_bbox': [10, 20, 90, 40], 'block_content': ''},
                    {'block_label': 'formula_number', 'block_bbox': [100, 20, 120, 40], 'block_content': '(1)'}]}])
            result = extract_formulas(pdf, pages, root, {}, 'test')
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['issues'][0]['compile']['reason'], 'empty_transcription')
            self.assertTrue(all((root / a['path']).is_file() for a in result['formulas'][0]['artifacts']))

    def test_cli_retains_text_when_native_formula_recognition_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = self.make_pdf(root, ['native'])
            def failed_formula_worker(command, **kwargs):
                envelope = Path(command[command.index('--output') + 1])
                envelope.write_text(json.dumps({'engine': {'formula_model': 'test'}, 'parameters': {},
                    'pages': [{'page_index': 0, 'width': 1190, 'height': 1684,
                        'extraction_method': 'native',
                        'issues': [{'domain': 'formula', 'code': 'structured_recognition_failed'}],
                        'parsing_res_list': [
                            {'block_label': 'text', 'block_bbox': [10, 50, 100, 70], 'block_content': 'Keep text'},
                            {'block_label': 'formula', 'block_bbox': [10, 20, 90, 40], 'block_content': ''},
                            {'block_label': 'formula_number', 'block_bbox': [100, 20, 120, 40], 'block_content': '(1)'}]}]}))
                return types.SimpleNamespace(returncode=0, stderr='')
            with patch.object(cli.subprocess, 'run', failed_formula_worker):
                result = cli.run(str(pdf), str(root / 'output'), ['text', 'formula'], root)
            self.assertEqual(result['status'], 'partial')
            self.assertEqual(result['domains']['formula']['status'], 'failed')
            self.assertEqual(result['domains']['text']['status'], 'success')
            self.assertEqual((root / 'output/text/document.txt').read_text(), 'Keep text\n')


if __name__ == '__main__':
    unittest.main()
