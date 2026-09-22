"""Inspection must cover late floats and every page of a multipage table."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
from pypdf import PdfWriter, PdfReader
from publication_pages import inspection_plan, END_PREFIX
from manuscript_publication import render_pages, publish, audit


class PublicationPagesTest(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='slr-inspection-')
        self.addCleanup(temp.cleanup);self.ws=Path(temp.name)
        self.gen=self.ws/'05_generation';self.gen.mkdir()
        self.source=self.gen/'full_draft_v2.tex'
        self.pdf=self.ws/'fixture.pdf'

    def fixture(self,body,aux='',count=12,roman_front=False):
        self.source.write_text(body,encoding='utf-8')
        self.source.with_suffix('.aux').write_text(aux,encoding='utf-8')
        writer=PdfWriter()
        for _ in range(count):writer.add_blank_page(width=595,height=842)
        if roman_front:
            writer.set_page_label(0,1,style='/r',start=1)
            writer.set_page_label(2,count-1,style='/D',start=1)
        with self.pdf.open('wb') as stream:writer.write(stream)

    def test_late_figures_tables_are_deduplicated_and_rendered_with_ids(self):
        body=r'\begin{table}\label{tab:T1}\end{table}\begin{figure}\label{fig:F1}\end{figure}\begin{table}\label{tab:T2}\end{table}'
        aux='\n'.join((r'\newlabel{tab:T1}{{1}{5}{Nested {caption}}{table.1}{}}',
                       r'\newlabel{fig:F1}{{1}{6}}',r'\newlabel{tab:T2}{{2}{12}}'))
        self.fixture(body,aux)
        paths,error,scope=render_pages(self.ws,self.pdf,include_scope=True)
        self.assertIsNone(error)
        self.assertEqual([p['page_number'] for p in scope['pages']],[1,5,6,12])
        self.assertEqual(scope['pages'][1]['assets'],['tab:T1'])
        self.assertEqual(len(paths),4)
        self.assertTrue(all(Path(p).exists() for p in paths))
        self.assertEqual(paths,[p['image'] for p in scope['pages']])

    def test_longtable_includes_continuation_pages(self):
        self.fixture(r'\begin{longtable}{ll}\label{tab:T1}\end{longtable}',
                     r'\newlabel{tab:T1}{{3}{4}}'+'\n'+
                     r'\newlabel{'+END_PREFIX+r'3}{{3}{7}}')
        result=inspection_plan(self.source,self.pdf)
        self.assertTrue(result['complete'])
        self.assertEqual([p['page_number'] for p in result['pages']],[1,4,5,6,7])
        self.assertTrue(all(p['assets']==['tab:T1'] for p in result['pages'][1:]))

    def test_missing_longtable_end_is_reported_without_guessing_pages(self):
        self.fixture(r'\begin{longtable}{ll}\label{tab:T1}\end{longtable}',
                     r'\newlabel{tab:T1}{{1}{5}}')
        paths,error,scope=render_pages(self.ws,self.pdf,include_scope=True)
        self.assertFalse(scope['complete']);self.assertTrue(error)
        self.assertEqual([p['page_number'] for p in scope['pages']],[1,5])
        self.assertIn(END_PREFIX,str(scope['issues']))

    def test_missing_aux_and_unlabelled_asset_are_not_complete(self):
        self.fixture(r'\begin{figure}Picture\end{figure}\begin{table}\label{tab:T1}\end{table}')
        result=inspection_plan(self.source,self.pdf)
        self.assertFalse(result['complete'])
        self.assertEqual({i['code'] for i in result['issues']},
                         {'asset_label_missing','aux_label_missing_or_ambiguous'})
        self.assertEqual([p['page_number'] for p in result['pages']],[1])

    def test_printed_page_one_after_roman_frontmatter_maps_to_pdf_page_three(self):
        self.fixture(r'\begin{figure}\label{fig:F1}\end{figure}',
                     r'\newlabel{fig:F1}{{1}{1}}',roman_front=True)
        result=inspection_plan(self.source,self.pdf)
        self.assertEqual([p['page_number'] for p in result['pages']],[1,3])
        self.assertEqual([p['page_label'] for p in result['pages']],['i','1'])

    def test_included_aux_and_shared_asset_page(self):
        self.fixture(r'\begin{table}\label{tab:T1}\end{table}\begin{figure}\label{fig:F1}\end{figure}',
                     r'\@input{child.aux}')
        (self.gen/'child.aux').write_text(r'\newlabel{tab:T1}{{1}{5}}\newlabel{fig:F1}{{1}{5}}')
        result=inspection_plan(self.source,self.pdf)
        self.assertEqual([p['page_number'] for p in result['pages']],[1,5])
        self.assertEqual(set(result['pages'][1]['assets']),{'tab:T1','fig:F1'})

    @unittest.skipUnless(shutil.which('pdflatex'),'TeX unavailable')
    def test_real_longtable_end_tracking_preserves_source_and_excludes_following_prose(self):
        rows='\n'.join(fr'Row{i}&\rule{{0pt}}{{10mm}}Evidence\\' for i in range(1,51))
        text=(r'\documentclass{article}\usepackage{longtable,booktabs}\begin{document}'
              r'First page.\clearpage\begin{longtable}{p{3cm}p{8cm}}'
              r'\caption{Comparison}\label{tab:T1}\\'
              r'\toprule Method&Result\\\midrule\endfirsthead'
              r'\toprule Method&Result\\\midrule\endhead'+'\n'+rows+'\n'+
              r'\bottomrule\end{longtable}\clearpage Following prose only.\end{document}')
        self.source.write_text(text)
        result=publish(self.ws)
        self.assertEqual(result['status'],'SUCCESS',result)
        self.assertEqual(self.source.read_text(),text)
        pdf=PdfReader(result['deliverable'])
        end=next(i+1 for i,p in enumerate(pdf.pages) if 'Row50' in p.extract_text())
        final=audit(self.ws,True)
        scope=final['inspection_scope']
        self.assertTrue(scope['complete'],scope)
        self.assertEqual([p['page_number'] for p in scope['pages']],list(range(1,end+1)))
        self.assertLess(end,len(pdf.pages))
        self.assertEqual(len(final['pages_to_read']),end)
        self.assertFalse(final['visual_review_complete'])


if __name__=='__main__':unittest.main()
