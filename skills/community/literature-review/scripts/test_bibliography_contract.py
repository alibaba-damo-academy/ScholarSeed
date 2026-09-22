"""Reference lists belong to the publisher, including requested complete lists."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
from bibliography_contract import inspect_bibliography
from task_contract import configure, read_request, atomic_json
from validate_outline import validate
from manuscript_publication import publish, audit


class BibliographyContractTest(unittest.TestCase):
    def test_configuration_rejects_reference_chapter_and_can_repair_legacy_request(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder);intent='请附完整的引用文献清单。'
            configure(ws,{'intent':intent})
            constraint={'id':'complete-references','kind':'required_section',
                        'value':{'title':'参考文献','role':'conclusion'},'verbatim':'完整的引用文献清单'}
            with self.assertRaisesRegex(ValueError,'publisher-owned'):
                configure(ws,{'constraints':[constraint]})
            old=read_request(ws);old['constraints']=[constraint]
            atomic_json(ws/'01_input/writing_request.json',old)
            other={**constraint,'kind':'other','value':'Provide the complete cited reference list.'}
            configure(ws,{'constraints':[other]})
            self.assertEqual(read_request(ws)['intent'],intent)

    def test_outline_rejects_reference_lists_at_both_levels_but_keeps_related_work(self):
        for title in ('参考文献','References','Bibliography','6. 参考书目'):
            for nested in (False,True):
                node={'section_id':'1','title':'相关工作与文献比较','description':'Compare mechanisms.'}
                target={'section_id':'1.1','title':title,'description':'List references.'}
                if nested:node['subsections']=[target]
                else:node['title']=title
                errors,_=validate({'survey_title':'Review','topic':'Topic','outline_tree':[node]},set(),{})
                self.assertTrue(any('publisher-owned' in e for e in errors),(title,nested,errors))
        errors,_=validate({'survey_title':'Review','topic':'Topic','outline_tree':[
            {'section_id':'1','title':'参考文献分析','description':'Compare literature methods.'}]},set(),{})
        self.assertEqual(errors,[])

    def test_duplicate_lists_across_includes_and_repeated_bibitems(self):
        sources={'main':r'\input{refs}\bibliography{citations}',
                 'refs.tex':r'\begin{thebibliography}{9}\bibitem{A}A\bibitem{A}B\end{thebibliography}',
                 'citations.bib':'@article{A,title={A}}'}
        codes={i['code'] for i in inspect_bibliography(sources)['issues']}
        self.assertEqual(codes,{'duplicate_bibliography','duplicate_bibitem_keys'})
        self.assertTrue(inspect_bibliography({'main':r'\section{参考文献}\bibliography{citations}'})['blocking'])

    def test_comments_examples_and_single_automatic_bibliography_are_allowed(self):
        text=('% '+r'\begin{thebibliography}{9}'+'\n'+
              r'\begin{verbatim}\bibitem{A}\bibliography{example}\end{verbatim}'+
              r'\bibliography{citations}')
        self.assertEqual(inspect_bibliography({'main':text})['status'],'SUCCESS')
        md='~~~\n## References\n~~~\n## Methods\nSupported result.'
        self.assertEqual(inspect_bibliography({'main':md},True)['status'],'SUCCESS')
        self.assertTrue(inspect_bibliography({'main':'## References\n[1] Work'},True)['blocking'])

    def test_duplicate_source_blocks_export_and_audit_cannot_mask_it(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder);gen=ws/'05_generation';gen.mkdir()
            (gen/'full_draft_v2.tex').write_text(
                r'\begin{thebibliography}{9}\bibitem{A}A\end{thebibliography}\bibliography{citations}')
            (gen/'generation_report.json').write_text(json.dumps({'status':'SUCCESS'}))
            self.assertEqual(audit(ws)['status'],'FAILED')
            with patch('manuscript_publication._run') as compiler:
                result=publish(ws)
            compiler.assert_not_called()
            self.assertEqual(result['code'],'BIBLIOGRAPHY_CONFLICT')
            self.assertFalse((ws/'06_output').exists())

    def test_duplicate_definition_warning_blocks_even_successful_compiler(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder);gen=ws/'05_generation';gen.mkdir()
            source=gen/'full_draft_v2.tex'
            source.write_text(r'\documentclass{article}\begin{document}Text\end{document}')
            def compile(*args):
                source.with_suffix('.pdf').write_bytes(b'%PDF fixture')
                source.with_suffix('.log').write_text("Package natbib Warning: Citation 'A' multiply defined.")
                return subprocess.CompletedProcess(args,0,stdout='',stderr='')
            with patch('manuscript_publication.shutil.which',return_value='fixture'),\
                 patch('manuscript_publication._run',side_effect=compile):
                result=publish(ws)
            self.assertEqual(result['code'],'BIBLIOGRAPHY_CONFLICT')
            self.assertEqual(result['compile']['verdict'],'bibliography_conflict')
            self.assertFalse((ws/'06_output').exists())


if __name__=='__main__':unittest.main()
