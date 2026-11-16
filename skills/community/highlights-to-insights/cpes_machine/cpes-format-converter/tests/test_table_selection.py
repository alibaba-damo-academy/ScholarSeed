"""Real PDF page scheduling with only expensive perception replaced."""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter.worker import convert_document
from cpes_format_converter.extract import normalize_pages
from cpes_format_converter.direct_tables import publish_tables,run_direct_tables
from cpes_format_converter.common import sha256_file

HTML='<table><tr><th>Method</th><th>Score</th></tr><tr><td>A</td><td>1.20</td></tr></table>'

class Backend:
    def __init__(self):self.layouts=0;self.scans=0;self.body_only=False;self.invalid=False
    def layout(self,image):
        self.layouts+=1
        return {'boxes':[{'label':'text' if self.body_only else 'table_title','coordinate':[50,100,700,180]},
                         {'label':'table','coordinate':[50,200,700,500]}]}
    def structured(self,*args):return {1:'' if self.invalid else HTML},[]
    def scan(self,image):
        self.scans+=1
        return {'parsing_res_list':[
            {'block_label':'table_title','block_bbox':[50,100,700,180],'block_content':f'Table {self.scans}: Caption.'},
            {'block_label':'table','block_bbox':[50,200,700,500],'block_content':HTML}]}

class TableSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def pdf(self,*,scan=False,duplicate=False,with_refs=False):
        path=self.root/'paper.pdf'
        pages = []
        for number in range(1, 7):
            if scan:
                pages.append({'rectangles': [(20, 20, 30, 30)]})
                continue
            caption = f'Table {1 if number == 2 or duplicate else 7}: Caption.' if number in (2, 5) else 'Body only.'
            texts = [{'at': (30, 80), 'text': caption}]
            if number == 6 and with_refs:
                texts.extend([
                    {'at': (30, 300), 'text': 'References', 'bold': True, 'size': 14},
                    {'at': (30, 350), 'text': 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'}])
            pages.append({'texts': texts})
        document_pdf(path, pages)
        return path
    def convert(self,pdf,backend,targets,**kwargs):
        info={};pages=convert_document(pdf,{'table'},backend,table_numbers=targets,search_info=info,**kwargs)
        return pages,info
    def test_native_targets_only_visit_caption_pages(self):
        b=Backend();pdf=self.pdf(with_refs=True);pages,info=self.convert(pdf,b,['1','7'],figure_scope='main')
        self.assertEqual([p['page_index']+1 for p in pages],[2,5]);self.assertEqual(b.layouts,2)
        self.assertEqual(info['candidate_pages'],{'1':[2],'7':[5]})
        self.assertEqual(info['matched_pages'],{'1':[2],'7':[5]});self.assertEqual(info['missing_tables'],[])
        self.assertTrue(info['stopped_early']);self.assertEqual(info['figure_scope']['boundary']['page_number'],6)
    def test_missing_target_falls_back_without_revisiting_candidate_pages(self):
        b=Backend();pages,info=self.convert(self.pdf(),b,['1','99'])
        self.assertEqual(b.layouts,6);self.assertEqual(len(pages),6);self.assertEqual(info['missing_tables'],['99'])
        self.assertFalse(info['stopped_early'])
    def test_body_reference_does_not_confirm_table(self):
        b=Backend();b.body_only=True;pages,info=self.convert(self.pdf(),b,['1'])
        self.assertEqual(len(pages),6);self.assertEqual(info['missing_tables'],['1'])
    def test_caption_and_region_without_structure_do_not_stop_search(self):
        b=Backend();b.invalid=True;pages,info=self.convert(self.pdf(),b,['1'])
        self.assertEqual(len(pages),6);self.assertEqual(info['missing_tables'],['1'])
    def test_scanned_all_scope_stops_after_last_target(self):
        b=Backend();pages,info=self.convert(self.pdf(scan=True),b,['1','2'])
        self.assertEqual(b.scans,2);self.assertEqual(b.layouts,0);self.assertEqual(info['matched_pages'],{'1':[1],'2':[2]})
        self.assertTrue(info['stopped_early'])
    def test_scan_main_scope_keeps_searching_until_boundary_verified(self):
        b=Backend();original=b.scan
        def scan(image):
            value=original(image)
            if b.scans==4:value['parsing_res_list'] += [
                {'block_label':'paragraph_title','block_bbox':[50,800,300,830],'block_content':'References'},
                {'block_label':'reference','block_bbox':[50,850,700,1100],'block_content':
                 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'}]
            return value
        b.scan=scan;pages,info=self.convert(self.pdf(scan=True),b,['1'],figure_scope='main')
        self.assertEqual(b.scans,4);self.assertEqual(info['figure_scope']['boundary']['page_number'],4)
        self.assertEqual(info['missing_tables'],[])
    def test_duplicate_indexed_captions_are_checked_before_stopping(self):
        b=Backend();pdf=self.pdf(duplicate=True);pages,info=self.convert(pdf,b,['1'])
        self.assertEqual(b.layouts,2);self.assertEqual(info['matched_pages']['1'],[2,5])
        (self.root/'table-cards').mkdir();result=publish_tables(pdf,normalize_pages(pages,allow_sparse=True),self.root,['1'])
        self.assertEqual(result['status'],'partial');self.assertIn('duplicate_table_number',[i['code'] for i in result['issues']])
    def test_all_tables_still_process_every_body_page(self):
        b=Backend();pages,info=self.convert(self.pdf(with_refs=True),b,[],figure_scope='main')
        self.assertEqual(b.layouts,6);self.assertEqual(len(pages),6)
    def test_direct_route_forwards_targets_and_returns_index_without_extra_files(self):
        pdf=self.pdf();b=Backend();observed={}
        (self.root/'table-cards').mkdir();(self.root/'system').mkdir()
        def payload(pdf,domains,*args,table_numbers=None,**kwargs):
            observed['targets']=table_numbers;observed['image_only']=kwargs.get('image_only')
            pages,info=self.convert(pdf,b,table_numbers,image_only=kwargs.get('image_only',False))
            return {'pages':pages,'search':info,'engine':{}}
        with patch('cpes_format_converter.direct_tables.build_payload',payload):
            result=run_direct_tables(pdf,self.root,str(pdf),sha256_file(pdf),['7'],'all',True,0)
        self.assertEqual(observed['targets'],['7']);self.assertTrue(observed['image_only'])
        self.assertEqual({p.name for p in (self.root/'table-cards/table-7').iterdir()},{'table.png','caption.md'})
        index=result['catalog']['table_index']
        self.assertEqual(index['matched_pages'],{'7':[5]});self.assertEqual(index['processed_pages'],[5])
        self.assertEqual(index['pdf_sha256'],sha256_file(pdf))
        self.assertEqual([p.name for p in (self.root/'system').iterdir()],['document.txt'])
        self.assertEqual({l['page_number'] for l in result['catalog']['native_context']['source']['lines']},set(range(1,7)))

    def test_missing_native_caption_falls_back_to_scan_after_indexed_target(self):
        pdf=self.root/'mixed.pdf'
        document_pdf(pdf, [{'rectangles': [(20, 20, 40, 40)]} if number == 1 else
                           {'texts': [{'at': (30, 80), 'text': 'Table 7: Caption.' if number == 5 else 'Body only.'}]}
                           for number in range(1, 7)])
        backend=Backend();pages,info=self.convert(pdf,backend,['1','7'])
        self.assertEqual(info['processed_pages'],[5,1])
        self.assertEqual([p['page_index']+1 for p in pages],[1,5])
        self.assertEqual((backend.layouts,backend.scans),(1,1))
        self.assertEqual(info['missing_tables'],[])

    def test_late_ocr_boundary_removes_post_reference_matches(self):
        b=Backend();original=b.scan
        def scan(image):
            value=original(image)
            # Target 3 is physically on page 3, but is after a References heading
            # whose bibliography evidence becomes sufficient on page 4.
            if b.scans==3:
                value['parsing_res_list'].append({'block_label':'paragraph_title',
                    'block_bbox':[50,60,300,90],'block_content':'References'})
            if b.scans==4:
                value['parsing_res_list'].append({'block_label':'reference','block_bbox':[50,600,700,1100],
                    'block_content':'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'})
            return value
        b.scan=scan;pages,info=self.convert(self.pdf(scan=True),b,['3'],figure_scope='main')
        self.assertEqual(info['figure_scope']['boundary']['page_number'],3)
        self.assertEqual(info['processed_pages'],[1,2,3,4])
        self.assertEqual([p['page_index']+1 for p in pages],[1,2,3])
        self.assertEqual(info['missing_tables'],['3'])
        self.assertNotIn('3',info['matched_pages'])
