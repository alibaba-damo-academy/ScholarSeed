import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter.direct_tables import explicit_rowspan_slots,publish_tables
from cpes_format_converter.extract import table_rows,table_document,normalize_pages

class DirectTableTests(unittest.TestCase):
    def test_rowspan_headers_preserve_cell_coordinates(self):
        rows,_=table_rows('<table><tr><th rowspan="2">Method</th><th colspan="2">Score</th></tr><tr><th>Validation</th><th>Test</th></tr><tr><td>A</td><td>1.2</td><td>2.3</td></tr></table>')
        rows,columns=explicit_rowspan_slots(rows)
        script=Path(__file__).resolve().parents[2]/'cpes-table/scripts/build_table_structure.py'
        spec=importlib.util.spec_from_file_location('table_structure_test',script);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        structure=m.build({'table_id':'t1','label':None,'expanded_latex':table_document(rows,columns,''),'line_start':1,'source_tex':'table.tex'})
        cells=structure['groups'][0]['data_cells']
        self.assertEqual([c['column_path'] for c in cells],[['Score','Validation'],['Score','Test']])
        self.assertEqual(cells[0]['row_dimensions'][0]['name'],'Method')

    def test_direct_table_crop_needs_no_compile_and_ignores_body_mentions(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'table-cards').mkdir();pdf=root/'source.pdf'
            document_pdf(pdf, [{}], size=(400, 400))
            raw={'page_index':0,'width':800,'height':800,'extraction_method':'native','parsing_res_list':[
                {'block_label':'table_title','block_content':'Table 2: Results','block_bbox':[50,50,350,90]},
                {'block_label':'table','block_content':'<table><tr><td>A</td><td>1.20</td></tr></table>','block_bbox':[50,100,350,300]},
                {'block_label':'text','block_content':'Table 1 reports better results.','block_bbox':[50,310,350,350]}]}
            with patch('cpes_format_converter.extract.compile_latex',side_effect=AssertionError('No compilation')):
                result=publish_tables(pdf,normalize_pages([raw]),root,['2'])
            self.assertEqual(result['count'],1);self.assertEqual(result['tables'][0]['table_number'],'2')
            self.assertEqual({p.name for p in (root/'table-cards/table-2').iterdir()},{'table.png','caption.md','table.tex'})

    def test_roman_table_number_is_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'table-cards').mkdir();pdf=root/'source.pdf'
            document_pdf(pdf, [{}], size=(400, 400))
            raw={'page_index':0,'width':800,'height':800,'extraction_method':'native','parsing_res_list':[
                {'block_label':'table_title','block_content':'TABLE II: Results','block_bbox':[50,50,350,90]},
                {'block_label':'table','block_content':'<table><tr><td>A</td><td>1.20</td></tr></table>','block_bbox':[50,100,350,300]},
                {'block_label':'text','block_content':'Table 1 reports better results.','block_bbox':[50,310,350,350]}]}
            with patch('cpes_format_converter.extract.compile_latex',side_effect=AssertionError('No compilation')):
                result=publish_tables(pdf,normalize_pages([raw]),root,['ii'])
            self.assertEqual(result['count'],1);self.assertEqual(result['tables'][0]['table_number'],'II')
            self.assertEqual({p.name for p in (root/'table-cards/table-ii').iterdir()},{'table.png','caption.md','table.tex'})

    def test_stacked_tables_use_nearest_caption_without_figure_direction_bias(self):
        from cpes_format_converter.direct_tables import table_caption
        table={'bbox_pixels':[100,200,400,300]}
        candidates=[{'number':'1','bbox_pixels':[100,160,400,190]}, {'number':'2','bbox_pixels':[100,350,400,380]}]
        self.assertEqual(table_caption(table,candidates,1000)['number'],'1')
