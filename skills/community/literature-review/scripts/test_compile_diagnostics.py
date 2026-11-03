import importlib.util
from pathlib import Path
import sys
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import manuscript_publication

path = Path(__file__).resolve().parent / "generation/publish/_fast/phase07_compile_latex.py"
spec = importlib.util.spec_from_file_location("compile_diagnostics", path)
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)


class CompileDiagnosticsTest(unittest.TestCase):
    def test_precompile_timeout_terminates_at_the_refinement_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'full_draft_v1.tex'
            source.write_text(r'\documentclass{article}\begin{document}Text.\end{document}')
            with patch.object(manuscript_publication, 'latex_engine', return_value='/tool/pdflatex'), patch.object(
                manuscript_publication.subprocess, 'run', side_effect=subprocess.TimeoutExpired('pdflatex', 10)
            ) as run:
                result = manuscript_publication.precompile(root, source)
            self.assertEqual(result['status'], 'TIMEOUT')
            run.assert_called_once()
            self.assertEqual(run.call_args.kwargs['timeout'], 10)
            self.assertEqual(source.read_text(), r'\documentclass{article}\begin{document}Text.\end{document}')

    @unittest.skipUnless(shutil.which('pdflatex'), 'TeX engine unavailable')
    def test_precompile_reports_source_error_without_touching_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'full_draft_v1.tex'
            original = r'\documentclass{article}\begin{document}\undefinedForTest\end{document}'
            source.write_text(original)
            result = manuscript_publication.precompile(root, source)
            self.assertEqual(result['status'], 'FAILED')
            self.assertIn('Undefined control sequence', str(result['errors']))
            self.assertEqual(source.read_text(), original)
            self.assertFalse(source.with_suffix('.pdf').exists())

    @unittest.skipUnless(shutil.which('pdflatex'), 'TeX engine unavailable')
    def test_template_longtable_breaks_pages_and_retains_last_row(self):
        from native_document import load_renderer
        from pypdf import PdfReader
        renderer=load_renderer()
        with tempfile.TemporaryDirectory(prefix='slr-longtable-') as folder:
            dest=Path(folder)
            shutil.copy(renderer.NEURIPS_TEMPLATE_DIR/renderer.NEURIPS_STY_FILENAME,dest)
            preamble=renderer._citation_preamble('english',{'citation_style':'numeric','natbib_options':'numbers,sort',
                'bibliography_style':'unsrtnat_scholarseed'})
            rows='\n'.join(fr'Row{i}&\rule{{0pt}}{{10mm}}Supported evidence\\' for i in range(1,51))
            body=(r'\begin{document}\begin{longtable}{p{3cm}p{8cm}}'
                  r'\caption{Evidence comparison}\label{tab:T1}\\'
                  r'\toprule Method&Evidence\\\midrule\endfirsthead'
                  r'\toprule Method&Evidence\\\midrule\endhead'+'\n'+rows+'\n'+
                  r'\bottomrule\end{longtable}\end{document}')
            (dest/'long.tex').write_text(preamble+'\n'+body,encoding='utf-8')
            result=subprocess.run(['pdflatex','-interaction=nonstopmode','-halt-on-error','long.tex'],
                                  cwd=dest,capture_output=True,text=True,errors='replace',timeout=60)
            self.assertEqual(result.returncode,0,result.stdout[-3000:])
            pdf=PdfReader(dest/'long.pdf')
            self.assertGreater(len(pdf.pages),1)
            self.assertIn('Row50',pdf.pages[-1].extract_text())
            self.assertNotIn('Float too large',(dest/'long.log').read_text(errors='replace'))

    @unittest.skipUnless(shutil.which('pdflatex') and shutil.which('xelatex'), 'TeX engines unavailable')
    def test_bold_math_compiles_in_both_language_templates(self):
        root=Path(__file__).resolve().parents[1]
        merge_path=root/'scripts/generation/merge/_fast/phase05_merge_full_draft.py'
        merge_spec=importlib.util.spec_from_file_location('bold_math_preamble',merge_path)
        merge=importlib.util.module_from_spec(merge_spec);merge_spec.loader.exec_module(merge)
        for language,engine in [('english','pdflatex'),('chinese','xelatex')]:
            with self.subTest(language=language),tempfile.TemporaryDirectory(prefix='slr-bm-') as folder:
                dest=Path(folder)
                if language=='english':
                    shutil.copy(root/'assets/templates/neurips/neurips_2026.sty',dest)
                preamble=merge._citation_preamble(language,{'citation_style':'numeric','natbib_options':'numbers,sort',
                    'bibliography_style':'unsrtnat_scholarseed'})
                (dest/'math.tex').write_text(preamble+'\n'+r'\begin{document}'+'\n'+
                    r'\[\bm{X}=\bm{U}\bm{V}^{\top},\quad\bm{\alpha}\in\mathbb{R}^{r}\]'+'\n'+
                    r'\end{document}')
                result=subprocess.run([engine,'-interaction=nonstopmode','-halt-on-error','math.tex'],
                    cwd=dest,capture_output=True,text=True,errors='replace',timeout=60)
                self.assertEqual(result.returncode,0,result.stdout[-4000:]+result.stderr)
                self.assertTrue((dest/'math.pdf').is_file())

    def test_tex_output_with_non_utf8_byte_does_not_abort_publication(self):
        with tempfile.TemporaryDirectory() as d:
            rc, text = compiler._run(
                [sys.executable, "-c", "import sys;sys.stdout.buffer.write(b'font warning: \\xe9\\n')"], Path(d))
            self.assertEqual(rc, 0)
            self.assertIn("font warning:", text)
            self.assertIn("\ufffd", text)

    def test_fatal_diagnostic_keeps_source_line_and_never_promotes_partial_pdf(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / "paper.pdf").write_bytes(b"%PDF-1.5 partial")
            (p / "paper.log").write_bytes(b"! Undefined control sequence.\nl.226 \\tch_{x}\nfont: \xe9\n")
            result = compiler._diagnose_compile(p / "paper.pdf", p / "paper.log", 1)
            self.assertEqual(result["verdict"], "partial_pdf")
            self.assertIn("l.226", result["error_contexts"][0])
            self.assertIn(r"\tch", result["error_contexts"][0])

if __name__ == "__main__":
    unittest.main()
