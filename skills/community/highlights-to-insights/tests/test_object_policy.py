"""Focus-based object selection must preserve prose and local retrievability."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

from pdf_fixture import document_pdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from reading_pipeline import prepare, resolve


class ObjectPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pdf = self.root / 'paper.pdf'
        self.pages = [
            {'texts': [{'at': (40, 50), 'text': 'Methods', 'bold': True, 'size': 14}] + [
                {'at': (40, top), 'text': text} for top, text in (
                    (100, 'FOCUSED loss weights are defined in equation (2).'),
                    (150, 'w(x) = min(x, 24) (2)'), (190, 'Here w denotes a capped weight.'),
                    (250, 'z = a + b (3)'), (320, 'Fig. 1 | UNMARKEDFIG output comparison.'),
                    (390, 'MAINPROSE reports a useful result; score = accuracy plus robustness.'),
                    (440, 'BACKGROUND compares Fig. 1 and Table 1.'))],
             'marks': [{'phrases': ['FOCUSED']}]},
            {'texts': [{'at': (40, 70), 'text': 'Table 1 | UNMARKEDTABLE measurements.'},
                       {'at': (40, 240), 'text': 'MAINRESULT remains useful even without the table.'}] + [
                {'at': (left, top), 'text': text} for top, first, second in (
                    (120, 'METHOD', 'SCORE'), (150, 'Alpha', '0.8'), (180, 'Beta', '0.7'))
                for left, text in ((50, first), (190, second))],
             'lines': [(left, 100, left, 190) for left in (40, 180, 320)] +
                      [(40, top, 320, top) for top in (100, 130, 160, 190)]},
            {'texts': [{'at': (40, 50), 'text': 'Appendix A', 'bold': True, 'size': 14},
                       {'at': (40, 100), 'text': 'Extended Data Fig. 2 | APPENDIXFIG explanation.'},
                       {'at': (40, 160), 'text': 'q = a - b (4)'},
                       {'at': (40, 240), 'text': 'UNRELATEDAPP remains local.'}]}]
        document_pdf(self.pdf, self.pages, size=(600, 800))

    def read(self, name='reading', goal='', mark=None):
        pdf = self.pdf
        if mark:
            pdf = self.root / f'{name}.pdf'
            pages = copy.deepcopy(self.pages)
            page, phrase = mark
            pages[page].setdefault('marks', []).append({'phrases': [phrase]})
            document_pdf(pdf, pages, size=(600, 800))
        out = self.root / name
        prepare(pdf, out, goal=goal)
        return json.loads((out / 'reading.json').read_text()), (out / 'packet.md').read_text(), out

    def test_unmarked_objects_are_local_but_body_explanations_remain(self):
        index, packet, _ = self.read()
        self.assertNotIn('UNMARKEDFIG', packet)
        self.assertNotIn('UNMARKEDTABLE', packet)
        self.assertNotIn('z = a + b', packet)
        self.assertNotIn('Alpha', packet)
        self.assertIn('MAINPROSE', packet)
        self.assertIn('MAINRESULT', packet)
        self.assertIn('Here w denotes a capped weight.', packet)
        self.assertTrue(any('UNMARKEDFIG' in r['text'] for r in index['lines']))
        self.assertTrue(index['packet_selection'].get('object_filter', {}).get('excluded_source_ids'))

    def test_formula_reference_from_marked_context_keeps_only_needed_formula(self):
        _, packet, _ = self.read()
        self.assertIn('w(x) = min(x, 24) (2)', packet)
        self.assertNotIn('z = a + b (3)', packet)


    def test_marked_formula_is_kept_even_without_a_reference(self):
        _, packet, _ = self.read(mark=(0, 'z = a + b'))
        self.assertIn('z = a + b (3)', packet)

    def test_marked_table_cell_keeps_the_table_and_its_caption(self):
        _, packet, _ = self.read(mark=(1, 'Beta'))
        for value in ('UNMARKEDTABLE', 'METHOD', 'SCORE', 'Alpha', 'Beta', '0.8', '0.7'):
            self.assertIn(value, packet)
        self.assertNotIn('UNMARKEDFIG', packet)

    def test_explicit_questions_can_retrieve_unmarked_appendix_objects(self):
        _, packet, _ = self.read(goal='Explain Extended Data Fig. 2 and equation (4).')
        self.assertIn('APPENDIXFIG', packet)
        self.assertIn('q = a - b (4)', packet)
        self.assertNotIn('UNRELATEDAPP', packet)

    def test_explicitly_retrieving_a_filtered_source_is_not_silently_skipped(self):
        from cpes_machine.writer import prepare_request, load_request
        index, packet, out = self.read()
        source = next(s for s in index['catalog'] if s['kind'] == 'paper_text' and
                      'z = a + b' in resolve(index, s['id'])['text'])
        self.assertNotIn(source['id'], index['packet_selection']['source_ids'])
        request = self.root / 'request.json'
        prepare_request(out / 'reading.json', request, sources=[source['id']])
        self.assertEqual(load_request(request)['prompt'].count('z = a + b'), 1)
        self.assertEqual(load_request(request)['images'], [])


if __name__ == '__main__':
    unittest.main()
