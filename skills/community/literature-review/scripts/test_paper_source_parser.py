"""Behavioral checks: captions survive, float data cannot pollute sentence IDs."""
import gzip
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

import pdf_fixture

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
from paper_source_parser import ParseError,parse_source
sys.path.insert(0,str(Path(__file__).resolve().parent/'processing'))
from step2_prepare import _parse_sentences_index,_get_sections

MAIN=r'''\documentclass{article}
\newcommand{\vx}{\mathbf{x}}
\begin{document}
The rate is 3.14, e.g. on the first trial. A second sentence follows.
\input{parts/method}
\begin{figure}[t]\includegraphics{private-pixels.pdf}
\caption[Short]{A figure with \textbf{nested text}. Its uncertainty is $\sigma=0.2$.}
\end{figure}
\begin{table}\centering\caption{A comparison of observations.}
\begin{tabular}{lr}Model & SecretCell998877 \\ A & 987654321 \\\end{tabular}
\end{table}
\begin{equation}\vx_{t+1}=\vx_t+1.25\end{equation}
The conclusion remains after the table.
\end{document}'''

class PaperSourceTest(unittest.TestCase):
    def test_tex_and_archives_keep_captions_and_math_but_not_table_data(self):
        files={'main.tex':MAIN.encode(),'parts/method.tex':b'The method includes a calibration stage.'}
        for kind in ['tar','gzip','zip']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
                stream=io.BytesIO()
                if kind=='zip':
                    with zipfile.ZipFile(stream,'w') as archive:
                        for name,data in files.items():archive.writestr(name,data)
                else:
                    with tarfile.open(fileobj=stream,mode='w') as archive:
                        for name,data in files.items():
                            info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))
                data=gzip.compress(stream.getvalue()) if kind=='gzip' else stream.getvalue()
                source=Path(tmp)/'misleading.bin';source.write_bytes(data)
                out=Path(tmp)/'parsed';result=parse_source(source,out);text=result['sentences']
                self.assertEqual(result['status'],'ok')
                self.assertEqual(result['caption_count'],2)
                for value in ['A figure with nested text.','A comparison of observations.','calibration stage','3.14',r'\mathbf{x}',r'\sigma=0.2','The conclusion remains']:self.assertIn(value,text)
                for value in ['SecretCell998877','987654321','private-pixels','\\begin{tabular','ZZPROTECTED']:self.assertNotIn(value,text)
                idx=_parse_sentences_index(text)
                self.assertEqual(list(idx),list(range(1,result['n_sentences']+1)))
                self.assertEqual(len(idx),len(text.splitlines()))
                self.assertEqual(_get_sections({'sentences':text}),text)
                self.assertEqual(parse_source(source)['sentences'],text)

    def test_pdf_keeps_caption_and_removes_table_cells_and_image_region(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf=pdf_fixture.open();page=pdf.new_page(width=600,height=800)
            page.insert_text((50,55),'The experiment has two conditions. Values are compared below.')
            page.insert_text((50,95),'Table 1. Comparison under fixed conditions.')
            for y in [120,150,180,210]:page.draw_line((50,y),(450,y))
            for x in [50,250,450]:page.draw_line((x,120),(x,210))
            for x,y,text in [(60,140,'Method'),(260,140,'Value'),(60,170,'SecretCell998877'),(260,170,'987654321'),(60,200,'OtherCell'),(260,200,'876543210')]:page.insert_text((x,y),text)
            page.insert_text((50,250),'The paragraph after the table remains available.')
            from PIL import Image
            raw=io.BytesIO();Image.new('RGB',(100,100),'blue').save(raw,format='PNG')
            page.insert_image(pdf_fixture.Rect(50,300,200,450),stream=raw.getvalue())
            page.insert_text((60,350),'PlotTickNoise778899')
            page.insert_text((50,480),'Figure 1. Image of the experimental setting.')
            source=Path(tmp)/'paper.pdf';pdf.save(source);pdf.close()
            result=parse_source(source,Path(tmp)/'parsed');text=result['sentences']
            self.assertEqual(result['status'],'ok')
            self.assertEqual(result['caption_count'],2)
            for value in ['Table 1. Comparison','Figure 1. Image','paragraph after']:self.assertIn(value,text)
            for value in ['SecretCell998877','987654321','876543210','PlotTickNoise778899']:self.assertNotIn(value,text)

    def test_unsafe_or_unknown_archives_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'bad.zip'
            with zipfile.ZipFile(source,'w') as archive:archive.writestr('../escape.tex',MAIN)
            with self.assertRaisesRegex(ParseError,'unsafe'):parse_source(source)
            source.write_bytes(b'Unknown binary\x00\x01')
            with self.assertRaisesRegex(ParseError,'unsupported'):parse_source(source)

    def test_pdf_columns_are_not_interleaved_by_vertical_position(self):
        with tempfile.TemporaryDirectory() as tmp:
            doc=pdf_fixture.open();page=doc.new_page(width=600,height=800)
            page.insert_text((50,100),'Left first sentence.')
            page.insert_text((330,100),'Right first sentence.')
            page.insert_text((50,140),'Left second sentence.')
            page.insert_text((330,140),'Right second sentence.')
            source=Path(tmp)/'columns.pdf';doc.save(source);doc.close()
            text=parse_source(source)['sentences']
            self.assertLess(text.index('Left second'),text.index('Right first'))

    def test_pdf_unknown_table_layout_is_reported_not_claimed_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            doc=pdf_fixture.open();page=doc.new_page()
            page.insert_text((50,100),'Table 1. A borderless layout that is not identified.')
            page.insert_text((50,150),'MethodA 77.9 1000 0.1')
            source=Path(tmp)/'uncertain.pdf';doc.save(source);doc.close()
            result=parse_source(source)
            self.assertEqual(result['status'],'partial')
            self.assertTrue(any('unverified' in w for w in result['warnings']))

    def test_sentence_final_integer_stays_with_the_preceding_noun(self):
        import pysbd
        from paper_source_parser import _sentence_parts
        text='Top: Results for model 5. Bottom: Results for models 5 and 6. Note that both are measured.'
        parts=_sentence_parts(pysbd.Segmenter(language='en',clean=False),text)
        self.assertEqual(parts,['Top: Results for model 5.','Bottom: Results for models 5 and 6.','Note that both are measured.'])

if __name__=='__main__':unittest.main()
