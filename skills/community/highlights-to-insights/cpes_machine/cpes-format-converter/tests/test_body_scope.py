import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter import cli
from cpes_format_converter.worker import convert_document
from cpes_format_converter.common import ConverterError
from cpes_format_converter.pdf import PDFDocument
from cpes_format_converter.scope import before_boundary, detect_native_boundary, detect_ocr_boundary, filter_pages


def native_boundary(pages, *, size=(595, 842)):
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / 'boundary.pdf'
        document_pdf(path, pages, size=size)
        with PDFDocument(path) as document:
            return detect_native_boundary(document)


class Backend:
    def __init__(self):self.layouts=0;self.scans=0
    def layout(self,image):
        self.layouts+=1
        return {'boxes':[
            {'label':'image','score':.99,'coordinate':[50,50,500,160]},
            {'label':'figure_title','score':.99,'coordinate':[50,175,700,210]},
            {'label':'image','score':.99,'coordinate':[50,1000,500,1250]},
            {'label':'figure_title','score':.99,'coordinate':[50,1275,700,1310]}]}
    def structured(self,*args):return {},[]
    def scan(self,image):
        self.scans+=1
        rows=[{'block_label':'image','block_bbox':[50,50,500,160],'block_content':''},
              {'block_label':'figure_title','block_bbox':[50,175,700,210],'block_content':f'Figure {self.scans}: Caption.'}]
        if self.scans==2:rows.append({'block_label':'paragraph_title','block_bbox':[50,500,250,530],'block_content':'References'})
        if self.scans==2:
            rows.append({'block_label':'text','block_bbox':[50,550,700,700],'block_content':
                'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'})
        return {'parsing_res_list':rows}


class BodyScopeTests(unittest.TestCase):
    def pdf(self,root,heading='References',scan=False):
        path=root/'input.pdf'
        pages = []
        for number in range(3):
            if scan:
                pages.append({'rectangles': [(30, 30, 100, 100)]})
                continue
            texts = [{'at': (30, 100), 'text': f'Figure {number+1 if number < 2 else 4}: Caption.'}]
            if number == 1:
                texts.extend([
                    {'at': (30, 300), 'text': heading, 'bold': True, 'size': 14},
                    {'at': (30, 350), 'text': 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'},
                    {'at': (30, 650), 'text': 'Figure 3: After references.'}])
            pages.append({'texts': texts})
        document_pdf(path, pages)
        return path

    def convert(self,root,scope='main',heading='References',scan=False):
        pdf=self.pdf(root,heading,scan);backend=Backend();commands=[]
        def worker(command,**kwargs):
            commands.append(command);info={}
            scope_arg=command[command.index('--figure-scope')+1] if '--figure-scope' in command else 'all'
            raw=convert_document(pdf,{'figure'},backend,search_info=info,figure_scope=scope_arg)
            Path(command[command.index('--output')+1]).write_text(json.dumps({'engine':{},'parameters':{},'search':info,'pages':raw}))
            return types.SimpleNamespace(returncode=0,stderr='')
        with patch.object(cli.subprocess,'run',worker):
            result=cli.run(str(pdf),str(root/'output'),['figure'],root,figure_scope=scope,native_context=True)
        return result,backend

    def test_main_scope_stops_before_appendix_and_keeps_pre_reference_figure_on_same_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);result,backend=self.convert(root)
            self.assertEqual(backend.layouts,2)
            self.assertEqual([x['figure_number'] for x in result['domains']['figure']['figures']],['1','2'])
            self.assertEqual(result['figure_scope']['boundary']['page_number'],2)
            source=json.loads((root/'output/native-context/source.json').read_text())
            rows={r['text']:r for r in source['lines']}
            self.assertTrue(rows['Figure 2: Caption.']['in_figure_scope'])
            self.assertFalse(rows['Figure 3: After references.']['in_figure_scope'])
            self.assertFalse(rows['Figure 4: Caption.']['in_figure_scope'])

    def test_explicit_all_scope_keeps_appendix_figures(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);result,backend=self.convert(root,'all')
            self.assertEqual(backend.layouts,3)
            self.assertEqual([x['figure_number'] for x in result['domains']['figure']['figures']],['1','2','3','4'])

    def test_unknown_boundary_does_not_silently_publish_entire_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with self.assertRaises(ConverterError) as caught:self.convert(root,heading='See references for details.')
            self.assertEqual(caught.exception.code,'body_boundary_unknown')
            self.assertFalse((root/'output').exists())

    def test_scan_uses_ocr_heading_and_stops_before_later_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);result,backend=self.convert(root,scan=True)
            self.assertEqual(backend.scans,2)
            self.assertEqual(result['figure_scope']['boundary']['method'],'ocr')
            self.assertEqual([x['figure_number'] for x in result['domains']['figure']['figures']],['1','2'])

    def test_right_column_boundary_keeps_left_column_body_below_heading(self):
        boundary={'page_number':2,'bbox_normalized':[.55,.3,.7,.32],'columns':2}
        self.assertTrue(before_boundary(2,[.1,.7,.4,.9],boundary))
        self.assertTrue(before_boundary(2,[.55,.1,.9,.2],boundary))
        self.assertFalse(before_boundary(2,[.55,.5,.9,.7],boundary))
        left={**boundary,'bbox_normalized':[.1,.3,.3,.32]}
        self.assertFalse(before_boundary(2,[.55,.1,.9,.2],left))

    def test_mentions_plain_field_toc_and_running_header_are_not_boundaries(self):
        pages = [
            {'texts': [{'at': (40, 100), 'text': 'The reference field contains a source identifier.'},
                       {'at': (40, 150), 'text': 'See References for implementation details.'},
                       {'at': (40, 200), 'text': 'References'}]},
            {'texts': [{'at': (40, 70), 'text': 'Table of Contents', 'bold': True, 'size': 16},
                       {'at': (40, 200), 'text': 'References', 'bold': True, 'size': 14},
                       {'at': (500, 200), 'text': '12'}]},
            {'texts': [{'at': (40, 20), 'text': 'References', 'bold': True, 'size': 14}]}]
        self.assertIsNone(native_boundary(pages)[0])
        pages.append({'texts': [
            {'at': (40, 200), 'text': '8 Bibliography', 'bold': True, 'size': 14},
            {'at': (40, 250), 'text': 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'}]})
        boundary, _ = native_boundary(pages)
        self.assertEqual(boundary['page_number'], 4)

    def test_bold_title_and_years_alone_are_not_enough(self):
        pages = [{'texts': [
            {'at': (40, 150), 'text': 'References', 'bold': True, 'size': 14},
            {'at': (40, 200), 'text': '2019 accuracy 82%\n2020 accuracy 83%\n2021 accuracy 87%\n2022 accuracy 90%'}]}]
        self.assertIsNone(native_boundary(pages)[0])

    def test_title_and_year_author_entries_work_without_doi_across_pages(self):
        pages = [{'texts': [{'at': (40, 650), 'text': 'References', 'bold': True, 'size': 14}]},
                 {'texts': [{'at': (40, 100), 'text': 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'}]}]
        boundary, _ = native_boundary(pages)
        self.assertEqual(boundary['page_number'], 1)
        self.assertGreaterEqual(boundary['citation_evidence']['year_entries'], 3)

    def test_native_heading_can_share_extraction_block_with_bibliography(self):
        pages = [{'texts': [
            {'at': (40, 100), 'text': 'References', 'bold': True, 'size': 14},
            {'at': (40, 114), 'text': 'Smith, A. 2021. First paper.\nJones, B. 2022. Second paper.\nLee, C. 2023. Third paper.', 'size': 10}]}]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'shared.pdf'
            document_pdf(path, pages)
            with PDFDocument(path) as document:
                self.assertEqual(len(document[0].blocks[0]['lines']), 4)
                boundary, _ = detect_native_boundary(document)
                self.assertIsNotNone(boundary)
                self.assertEqual(boundary['heading'], 'References')

    def test_centered_uppercase_regular_heading_with_bibliography_is_recognized(self):
        pages = [{'texts': [
            {'at': (40, 70), 'text': 'Body text has the same font size as the section title.'},
            {'at': (297.5, 212), 'text': 'REFERENCES', 'center': True}]}]
        self.assertIsNone(native_boundary(pages)[0])
        pages[0]['texts'].append({'at': (40, 250), 'text': 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'})
        boundary, _ = native_boundary(pages)
        self.assertIsNotNone(boundary)
        self.assertEqual(boundary['heading'], 'REFERENCES')
        self.assertGreaterEqual(boundary['citation_evidence']['year_entries'], 3)

    def test_dense_numbered_bibliography_without_heading_sets_boundary(self):
        pages = [{'texts': [{'at': (40, 100), 'text': 'Conclusion and discussion of the experiment.'}]},
                 {'texts': [{'at': (40, 70), 'text': '\n'.join(f'[{number}] A. Author, Study of particles. Journal of Physics 12, 34 (2020).' for number in range(1, 9))}]}]
        boundary, _ = native_boundary(pages)
        self.assertIsNotNone(boundary)
        self.assertEqual(boundary['page_number'], 2)
        self.assertIsNone(boundary['heading'])
        self.assertEqual(boundary['method'], 'native_bibliography')
        self.assertTrue(before_boundary(1,[.1,.1,.8,.9],boundary))
        self.assertFalse(before_boundary(2,[.1,.3,.8,.5],boundary))

    def test_headingless_numbered_results_with_years_are_not_bibliography(self):
        pages = [{'texts': [{'at': (40, 70), 'text': '\n'.join(
            f'[{number}] Result for the 2020 experiment: accuracy improved to 95 percent.' for number in range(1, 9))}]}]
        self.assertIsNone(native_boundary(pages)[0])

    def test_ocr_paragraph_columns_exclude_right_column_appendix(self):
        def region(label,text,box):
            return {'raw_label':label,'content':text,'bbox_pixels':box,'bbox_normalized':[v/1000 for v in box]}
        page={'page_number':1,'width':1000,'height':1000,'regions':[
            region('paragraph_title','References',[100,500,300,530]),
            region('reference_content','Smith, A. 2021. First paper.\nJones, B. 2022. Second paper.\nLee, C. 2023. Third paper.',[100,550,450,850]),
            region('reference_content','[4] Last author D. 2024. Final bibliography entry.',[550,50,950,100]),
            region('image','',[550,150,900,350]),
            region('figure_title','Figure 9: Appendix image.',[550,360,900,390])]}
        boundary=detect_ocr_boundary(page)
        self.assertEqual(boundary['columns'],2)
        kept=filter_pages([page],{'mode':'main','boundary':boundary})[0]['regions']
        self.assertFalse(any(r['raw_label'] in {'image','figure_title'} for r in kept))

    def test_ocr_cross_page_reference_content_confirms_heading(self):
        page={'page_number':1,'width':1000,'height':1000,'regions':[
            {'raw_label':'paragraph_title','content':'References','bbox_pixels':[50,900,250,930]}]}
        following={'regions':[{'raw_label':'reference_content','content':
            'Smith, A. 2021. First paper.\nJones, B. 2022. Second paper.\nLee, C. 2023. Third paper.'}]}
        self.assertIsNotNone(detect_ocr_boundary(page,following))

class ColumnCenteredHeadingTests(unittest.TestCase):
    def test_regular_uppercase_heading_in_either_column_needs_citations(self):
        for side in (0,1):
            with self.subTest(side=side):
                texts = [{'at': (left, top), 'text': 'Ordinary body text in this column.', 'size': 10}
                         for left in (40, 330) for top in (70, 90, 110)]
                left, right = (40, 270) if side == 0 else (330, 560)
                texts.append({'at': ((left+right)/2, 211), 'text': 'REFERENCES', 'size': 10, 'center': True})
                pages = [{'texts': texts}]
                self.assertIsNone(native_boundary(pages, size=(600, 800))[0])
                texts.append({'at': (left, 250), 'text': '[1] A. Author, First study, 2021.\n[2] B. Author, Next study, 2022.\n[3] C. Author, Last study, 2023.', 'size': 10})
                boundary, _ = native_boundary(pages, size=(600, 800))
                self.assertIsNotNone(boundary)
                self.assertEqual(boundary['columns'],2)
                self.assertTrue(boundary['citation_evidence']['strong'])
                self.assertGreaterEqual(boundary['citation_evidence']['year_entries'],3)

if __name__=='__main__':unittest.main()
