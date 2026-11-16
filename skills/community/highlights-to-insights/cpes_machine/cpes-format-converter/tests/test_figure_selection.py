import json
import sys
import tempfile
import unittest
from unittest.mock import patch
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter.worker import convert_document
from cpes_format_converter.extract import normalize_pages, extract_figures
from cpes_format_converter import cli


class FigureBackend:
    def __init__(self):
        self.layouts = 0
        self.scans = 0
    def layout(self, image):
        self.layouts += 1
        return {'boxes': [
            {'label': 'image', 'score': .99, 'coordinate': [50, 50, 500, 250]},
            {'label': 'figure_title', 'score': .99, 'coordinate': [50, 270, 600, 330]}]}
    def structured(self, *args):
        return {}, []
    def scan(self, image):
        self.scans += 1
        return {'parsing_res_list': [
            {'block_id': 0, 'block_label': 'image', 'block_bbox': [50,50,500,250], 'block_content': ''},
            {'block_id': 1, 'block_label': 'figure_title', 'block_bbox': [50,270,600,330],
             'block_content': f'Figure {self.scans}: Scanned caption.'}]}


class FigureSelectionTests(unittest.TestCase):
    def test_native_context_keeps_early_stop_and_reads_full_text_without_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); pdf=self.pdf(root); backend=FigureBackend()
            raw=convert_document(pdf, {'figure'}, backend, figure_numbers=['1'])
            self.assertEqual([p['page_index']+1 for p in raw], [2])
            def run_worker(command, **kwargs):
                envelope=Path(command[command.index('--output')+1])
                envelope.write_text(json.dumps({'engine':{},'parameters':{},'pages':raw}))
                return types.SimpleNamespace(returncode=0,stderr='')
            with patch.object(cli.subprocess,'run',run_worker):
                result=cli.run(str(pdf),str(root/'output'),['figure'],root,figure_numbers=['1'],native_context=True)
            self.assertEqual([f['figure_number'] for f in result['domains']['figure']['figures']],['1'])
            source=json.loads((root/'output/native-context/source.json').read_text())
            self.assertEqual(sorted({l['page_number'] for l in source['lines']}),[1,2,3,4,5,6])
            self.assertEqual(backend.layouts,1)
            self.assertEqual(backend.scans,0)

    def test_compact_output_keeps_line_coordinates_without_text_and_raw_copies(self):
        from cpes_format_converter.common import sha256_file
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);pdf=self.pdf(root);backend=FigureBackend()
            raw=convert_document(pdf,{'figure'},backend,figure_numbers=['1'])
            def worker(command,**kwargs):
                Path(command[command.index('--output')+1]).write_text(json.dumps({'engine':{},'parameters':{},'pages':raw}))
                return types.SimpleNamespace(returncode=0,stderr='')
            with patch.object(cli.subprocess,'run',worker):
                result=cli.run(str(pdf),str(root/'output'),['figure'],root,figure_numbers=['1'],native_context=True,compact_output=True)
            output=root/'output';source=json.loads((output/'native-context/source.json').read_text())
            self.assertFalse((output/'raw').exists())
            self.assertFalse((output/'native-context/document.numbered.txt').exists())
            self.assertEqual(source['text_storage'],'document-lines')
            self.assertTrue(all('text' not in row and 'bbox_pixels' in row for row in source['lines']))
            self.assertEqual(len((output/'native-context/document.txt').read_text().splitlines()),source['line_count'])
            for entry in [result['layout'],*result['native_context']['artifacts']]:
                self.assertEqual(sha256_file(output/entry['path']),entry['sha256'])
            metadata=json.loads((output/'figures/figure-1/figure.json').read_text())
            self.assertNotIn('content',metadata['caption'])
            self.assertEqual(metadata['caption']['content_ref'],'caption.md')

    def pdf(self, root, scanned=False):
        pdf = root/'sample.pdf'
        pages = []
        for number in range(1, 7):
            caption = f'Figure {1 if number == 2 else 7}: Actual caption.' if number in (2, 5) else 'Body text only.'
            pages.append({'rectangles': [(25, 25, 250, 125)]} if scanned else
                         {'texts': [{'at': (30, 150), 'text': caption}]})
        document_pdf(pdf, pages)
        return pdf

    def test_two_targets_process_only_indexed_pages_and_keep_source_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); backend=FigureBackend(); info={}
            pdf=self.pdf(root)
            raw=convert_document(pdf, {'figure'}, backend, figure_numbers=['1','7'], search_info=info)
            self.assertEqual(backend.layouts, 2)
            self.assertEqual(backend.scans, 0)
            self.assertEqual([p['page_index']+1 for p in raw], [2,5])
            self.assertEqual(info['candidate_pages'], {'1':[2], '7':[5]})
            pages=normalize_pages(raw, allow_sparse=True)
            result=extract_figures(pdf,pages,root,{},figure_numbers=['7'])
            self.assertEqual(result['status'], 'success')
            self.assertEqual([f['figure_number'] for f in result['figures']], ['7'])
            metadata=json.loads((root/'figures/figure-7/figure.json').read_text())
            self.assertEqual(metadata['page_number'], 5)
            self.assertFalse((root/'figures/figure-1').exists())

    def test_scan_stops_when_all_requested_figures_are_paired(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); backend=FigureBackend(); info={}
            raw=convert_document(self.pdf(root,True), {'figure'}, backend, figure_numbers=['1','2'],search_info=info)
            self.assertEqual(backend.scans, 2)
            self.assertEqual(len(raw), 2)
            self.assertEqual(info['missing_figures'], [])

    def test_native_context_on_scan_does_not_invoke_more_ocr(self):
        from cpes_format_converter.native import export_native_context
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); backend=FigureBackend(); pdf=self.pdf(root,True)
            convert_document(pdf, {'figure'}, backend, figure_numbers=['1'])
            result=export_native_context(pdf,root,'fixture-sha')
            self.assertEqual(backend.scans,1)
            self.assertEqual(result['line_count'],0)
            self.assertEqual(result['pages_without_native_text'],[1,2,3,4,5,6])

    def test_missing_target_is_explicit_and_retains_found_figures(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); backend=FigureBackend(); info={}
            pdf=self.pdf(root)
            raw=convert_document(pdf, {'figure'}, backend, figure_numbers=['1','99'],search_info=info)
            self.assertEqual(info['missing_figures'], ['99'])
            result=extract_figures(pdf,normalize_pages(raw,allow_sparse=True),root,{},figure_numbers=['1','99'])
            self.assertEqual(result['status'], 'partial')
            self.assertIn({'code':'requested_figure_not_found','figure':'99'}, result['issues'])

    def test_partial_pages_require_explicit_normalizer_mode(self):
        raw=[{'page_index':4,'width':100,'height':100,'parsing_res_list':[]}]
        with self.assertRaises(Exception): normalize_pages(raw)
        self.assertEqual(normalize_pages(raw,allow_sparse=True)[0]['page_number'],5)

    def test_body_reference_is_not_accepted_as_a_caption(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); backend=FigureBackend(); info={}
            original_layout=backend.layout
            def body_layout(image):
                result=original_layout(image)
                result['boxes'][1]['label']='text'
                return result
            backend.layout=body_layout
            convert_document(self.pdf(root), {'figure'}, backend, figure_numbers=['7'],search_info=info)
            self.assertEqual(info['missing_figures'], ['7'])

    def test_caption_without_a_visual_does_not_trigger_early_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); backend=FigureBackend(); info={}
            original_scan=backend.scan
            def scan_without_first_visual(image):
                value=original_scan(image)
                if backend.scans==1:
                    value['parsing_res_list']=value['parsing_res_list'][1:]
                return value
            backend.scan=scan_without_first_visual
            raw=convert_document(self.pdf(root,True),{'figure'},backend,figure_numbers=['1'],search_info=info)
            self.assertEqual(len(raw),6)
            self.assertEqual(info['missing_figures'],['1'])

    def test_duplicate_indexed_captions_are_checked_before_stopping(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); pdf=root/'duplicates.pdf'; backend=FigureBackend(); info={}
            document_pdf(pdf, [{'texts': [{'at': (30, 150), 'text': 'Figure 1: Duplicate caption.'}]}
                               for number in range(2)])
            raw=convert_document(pdf,{'figure'},backend,figure_numbers=['1'],search_info=info)
            self.assertEqual(backend.layouts,2)
            result=extract_figures(pdf,normalize_pages(raw,allow_sparse=True),root,{},figure_numbers=['1'])
            self.assertEqual(result['status'],'partial')
            self.assertIn({'code':'duplicate_figure_number','figure':'1'},result['issues'])

    def test_cli_forwards_targets_and_exports_a_source_bound_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); pdf=self.pdf(root); backend=FigureBackend()
            def run_worker(command, **kwargs):
                targets=[command[i+1] for i, part in enumerate(command) if part=='--figure']
                self.assertEqual(targets, ['1','7'])
                info={}
                pages=convert_document(pdf,{'figure'},backend,figure_numbers=targets,search_info=info)
                envelope=Path(command[command.index('--output')+1])
                envelope.write_text(json.dumps({'engine':{},'parameters':{},'search':info,'pages':pages}))
                return types.SimpleNamespace(returncode=0,stderr='')
            with patch.object(cli.subprocess,'run',run_worker):
                result=cli.run(str(pdf),str(root/'output'),[],root,figure_numbers=['1','7'])
            self.assertEqual(result['status'],'success')
            self.assertEqual(result['requested_domains'],['figure'])
            index=json.loads((root/'output/figure-index.json').read_text())
            self.assertEqual(index['pdf_sha256'],result['source']['sha256'])
            self.assertEqual(index['matched_pages'],{'1':[2],'7':[5]})
            layout=json.loads((root/'output/layout.json').read_text())
            self.assertEqual(layout['page_count'],6)
            self.assertEqual(layout['processed_page_count'],2)
            self.assertEqual(layout['scope'],'selected_figures')


if __name__=='__main__': unittest.main()
