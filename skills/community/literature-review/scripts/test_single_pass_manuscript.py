"""Source handoff regressions replacing the removed JSON acceptance contract."""
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
import pdf_fixture
from manuscript_publication import publish,audit,render_pages,safe_title_stem

class SinglePassTest(unittest.TestCase):
    def test_title_filename_replaces_spaces_colons_and_unsafe_characters(self):
        self.assertEqual(safe_title_stem('低秩矩阵分解：理论 / 方法?'),
                         '低秩矩阵分解_理论_方法')
        self.assertEqual(safe_title_stem('  A   B: C  '),'A_B_C')

    def test_postcheck_renders_only_first_three_pages_without_hash_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder);pdf=ws/'06_output/survey.pdf';pdf.parent.mkdir()
            document=pdf_fixture.open()
            for page_number in range(4):
                page=document.new_page()
                page.insert_text((50,90),f'Rendered page {page_number+1}.')
            document.save(pdf);document.close()
            first,error=render_pages(ws)
            self.assertIsNone(error)
            second,error=render_pages(ws)
            self.assertIsNone(error);self.assertEqual(len(first),3);self.assertNotEqual(first,second)
            for path in first+second:
                with Image.open(path) as rendered:
                    self.assertEqual(rendered.format,'PNG')
                    self.assertEqual(max(rendered.size),1400)

    def test_invalid_pdf_reports_render_error(self):
        with tempfile.TemporaryDirectory() as folder:
            workspace=Path(folder);pdf=workspace/'broken.pdf';pdf.write_bytes(b'%PDF broken')
            pages,error=render_pages(workspace,pdf)
            self.assertEqual(pages,[])
            self.assertTrue(error)

    def test_old_json_and_receipts_do_not_gate_native_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder);gen=ws/'05_generation';gen.mkdir()
            (gen/'full_draft_v2.md').write_text('# Main edited review\n\nSupported content.')
            internal=gen/'_internal';internal.mkdir();(internal/'manuscript_contract.json').write_text('invalid old json')
            status=gen/'_status';status.mkdir();(status/'publication_pending.json').write_text('{}')
            (gen/'manuscript.json').write_text('broken obsolete manuscript')
            self.assertEqual(publish(ws)['status'],'SUCCESS')
            self.assertEqual((ws/'06_output/survey.md').read_text(),'# Main edited review\n\nSupported content.')

    def test_unknown_current_citation_is_advisory_and_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder);gen=ws/'05_generation';gen.mkdir()
            (gen/'full_draft_v2.md').write_text(r'Result \citep{Missing}.')
            result=publish(ws)
            self.assertEqual(result['status'],'SUCCESS')
            self.assertEqual(result['checks'][0]['unknown'],['Missing'])
            self.assertIn(r'\citep{Missing}',(ws/'06_output/survey.md').read_text())

if __name__=='__main__':unittest.main()
