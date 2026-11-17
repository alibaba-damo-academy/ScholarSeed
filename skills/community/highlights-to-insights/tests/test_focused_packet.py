"""Complete body plus marked appendix units, with recoverable local exclusions."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from pdf_fixture import document_pdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT))


class FocusedPacketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hint-packet-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pdf = self.root / 'paper.pdf'
        pages = [{'texts': [{'at': (40, 50), 'text': heading, 'bold': True, 'size': 14},
                            {'at': (40, 90 if heading == 'Abstract' else 100), 'text': body}]}
                 for heading, body in (
                     ('Abstract', 'This study concerns probabilistic forecasts.'),
                     ('Methods', 'Ensembles represent uncertainty.'),
                     ('Results', 'UNMARKEDBODY results must remain in the initial packet.'),
                     ('Conclusion', 'Forecast diversity needs calibrated evaluation.'),
                     ('References', '1. Smith, J. Journal of Forecasts (2020).'))]
        pages[1].update(marks=[{'phrases': ['represent uncertainty']}],
                        notes=[{'at': (220, 120), 'text': 'Why use an ensemble?'}])
        pages.extend([
            {'texts': [{'at': (40, 30), 'text': 'Article', 'size': 14},
                       {'at': (40, 60), 'text': 'Methods', 'bold': True, 'size': 14},
                       {'at': (40, 100), 'text': 'DEFERREDMETHOD appears after the reference list.'}]},
            {'texts': [{'at': (40, 50), 'text': 'Appendix A', 'bold': True, 'size': 14},
                       {'at': (40, 100), 'text': 'HIDDENABLATION investigates orthogonal initialization.'}]},
            {'texts': [{'at': (40, 50), 'text': 'Appendix B', 'bold': True, 'size': 14},
                       {'at': (40, 100), 'text': 'APPENDIXMARK details refer to Extended Data Fig. 1.'},
                       {'at': (40, 200), 'text': 'UNMARKEDAPP material remains local.'}],
             'marks': [{'phrases': ['APPENDIXMARK']}]},
            {'texts': [{'at': (40, 100), 'text': 'Extended Data Fig. 1 | Procedure and its conditions.'}],
             'rectangles': [(50, 200, 300, 400)]},
            {'texts': [{'at': (40, 70), 'text': 'DEFINITION a and b are inputs to the appendix formula.'},
                       {'at': (40, 100), 'text': 'APPFORM = a + b'},
                       {'at': (40, 300), 'text': 'FARAPPENDIX text remains local.'}],
             'marks': [{'phrases': ['APPFORM']}]}])
        document_pdf(self.pdf, pages)
        from reading_pipeline import prepare
        prepare(self.pdf, self.root / 'reading')
        self.path = self.root / 'reading/reading.json'
        self.index = json.loads(self.path.read_text())
        self.packet = (self.path.parent / 'packet.md').read_text()

    def call(self, *args):
        p = subprocess.run([sys.executable, str(ROOT / 'scripts/reading.py'), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_unmarked_body_is_kept_and_unmarked_appendix_stays_local(self):
        self.assertNotIn('HIDDENABLATION', self.packet)
        self.assertTrue(any('HIDDENABLATION' in row['text'] for row in self.index['lines']))
        self.assertIn('This study concerns probabilistic forecasts.', self.packet)
        self.assertIn('Forecast diversity needs calibrated evaluation.', self.packet)
        self.assertIn('Why use an ensemble?', self.packet)
        self.assertIn('represent uncertainty', self.packet)
        self.assertIn('UNMARKEDBODY', self.packet)
        self.assertNotIn('UNMARKEDAPP', self.packet)
        self.assertEqual(self.index['packet_selection']['mode'], 'body_text_plus_focus_objects')

    def test_all_reading_signals_remain_and_shared_context_is_emitted_once(self):
        for source in self.index['catalog']:
            if source['record_ids']:
                self.assertIn(f"{source['id'][0]}{int(source['id'][1:]):03d} →", self.packet)
        emitted = [sid for u in self.index['packet_view']['units'] for sid in u['source_ids']]
        self.assertEqual(len(emitted), len(set(emitted)))
        self.assertEqual(set(emitted), set(self.index['packet_selection']['source_ids']))

    def test_section_directory_uses_actual_heading_and_only_candidate_boundaries(self):
        section = next(s for s in self.index['sections'] if s['title'] == 'Appendix A')
        self.assertEqual(section['boundary_status'], 'layout_candidate')
        self.assertNotIn(section['id'], self.packet)
        result = self.call('show', '--index', self.path, '--sections', section['id'])
        self.assertTrue(any('HIDDENABLATION' in s['text'] for s in result['sources']))

    def test_local_search_retrieves_omitted_original_without_model_calls(self):
        result = self.call('search', '--index', self.path, '--query', 'orthogonal initialization')
        self.assertEqual(result['model_calls'], 0)
        self.assertTrue(any('HIDDENABLATION' in s['excerpt'] for s in result['matches']))
        sid = result['matches'][0]['id']
        result = self.call('show', '--index', self.path, '--sources', sid)
        self.assertIn('HIDDENABLATION', result['sources'][0]['text'])

    def test_isolated_request_only_adds_explicitly_selected_original(self):
        from cpes_machine.writer import prepare_request, load_request
        block = next(s for s in self.index['catalog'] if s['kind'] == 'paper_text' and s['page'] == 7 and len(s['line_ids']) == 1 and any(
            r['id'] in s['line_ids'] and 'HIDDENABLATION' in r['text'] for r in self.index['lines']))
        path = self.root / 'request.json'
        prepare_request(self.path, path, sources=[block['id']])
        prompt = load_request(path)['prompt']
        self.assertEqual(prompt.count('HIDDENABLATION'), 1)
        self.assertIn('Why use an ensemble?', prompt)
        self.assertEqual(load_request(path)['additional_source_ids'], [block['id']])

    def test_unknown_additional_source_is_rejected_before_request_is_written(self):
        from cpes_machine.writer import prepare_request
        path = self.root / 'request.json'
        with self.assertRaises(ValueError):
            prepare_request(self.path, path, sources=['B99999'])
        self.assertFalse(path.exists())

    def test_methods_after_references_are_included_without_treating_appendix_as_body(self):
        self.assertIn('DEFERREDMETHOD', self.packet)
        self.assertNotIn('Smith, J.', self.packet)
        roles = self.index['paper_scope']['source_roles']
        for source in self.index['catalog']:
            if source['kind'] == 'paper_text' and source['page'] == 6:
                self.assertEqual(roles[source['id']], 'body')
                self.assertIn(source['id'], self.index['packet_selection']['source_ids'])


    def test_local_scope_summary_does_not_dump_original_text(self):
        summary = self.call('scope', '--index', self.path)
        self.assertEqual(summary['model_calls'], 0)
        self.assertNotIn('HIDDENABLATION', json.dumps(summary))
        self.assertTrue(any(r['role'] == 'appendix' for r in summary['regions']))

    def test_marked_appendix_formula_keeps_nearby_definition_candidates(self):
        self.assertIn('APPFORM = a + b', self.packet)
        self.assertIn('DEFINITION a and b are inputs', self.packet)
        self.assertNotIn('FARAPPENDIX', self.packet)
        self.assertTrue(any(r['kind'] == 'formula' and r['page'] == 10 for r in self.index['packet_selection']['visual_requirements']))

    def test_object_crop_keeps_the_whole_page_instead_of_only_its_caption(self):
        from reading_pipeline import prepare
        out = self.root / 'explicit-figure'
        prepare(self.pdf, out, goal='Explain Extended Data Fig. 1.')
        self.path = out / 'reading.json'
        self.index = json.loads(self.path.read_text())
        source = next(s for s in self.index['catalog'] if s['kind'] == 'paper_text' and s['page'] == 9)
        result = self.call('crop', '--index', self.path, '--source', source['id'], '--out', self.root / 'figure.png')
        self.assertEqual(result['crop_scope'], 'page_for_visual_unit')
        self.assertGreater(result['clip_pdf_points'][3], 400)
        self.assertEqual(result['clip_pdf_points'][:2], [0, 0])

    def test_reviewed_scope_overrides_are_bound_to_the_pdf_and_source_file(self):
        from reading_pipeline import prepare
        source = next(s for s in self.index['catalog'] if s['kind'] == 'paper_text' and s['page'] == 7 and any(
            r['id'] in s['line_ids'] and 'HIDDENABLATION' in r['text'] for r in self.index['lines']))
        review = self.root / 'scope.json'
        review.write_text(json.dumps({'schema_version': 1, 'pdf_sha256': self.index['document']['sha256'],
            'native_index_sha256': self.index['paper_scope']['native_index_sha256'],
            'overrides': [{'source_ids': [source['id']], 'role': 'body'}]}))
        out = self.root / 'reviewed'
        prepare(self.pdf, out, scope=review)
        self.assertIn('HIDDENABLATION', (out / 'packet.md').read_text())
        self.assertIn('scope_review', {b['role'] for b in json.loads((out / 'reading.json').read_text())['bindings']})
        review.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'changed'):
            prepare(self.pdf, out, scope=review)

    def test_scope_review_cannot_reuse_ids_from_a_different_native_index(self):
        from reading_pipeline import prepare
        review = self.root / 'wrong-scope.json'
        review.write_text(json.dumps({'schema_version': 1, 'pdf_sha256': self.index['document']['sha256'],
            'native_index_sha256': '0' * 64, 'overrides': []}))
        out = self.root / 'wrong-scope'
        with self.assertRaisesRegex(ValueError, 'binding'):
            prepare(self.pdf, out, scope=review)
        self.assertFalse(out.exists())

    def test_reviewed_scope_ranges_are_inclusive_and_reversed_ranges_fail(self):
        from reading_pipeline import prepare
        sources = [s['id'] for s in self.index['catalog'] if s['kind'] == 'paper_text' and s['page'] == 7]
        value = {'schema_version': 1, 'pdf_sha256': self.index['document']['sha256'],
                 'native_index_sha256': self.index['paper_scope']['native_index_sha256'],
                 'overrides': [{'first_source_id': sources[0], 'last_source_id': sources[-1], 'role': 'body'}]}
        review = self.root / 'range.json'
        review.write_text(json.dumps(value))
        out = self.root / 'range-reading'
        prepare(self.pdf, out, scope=review)
        index = json.loads((out / 'reading.json').read_text())
        self.assertTrue(all(index['paper_scope']['source_roles'][sid] == 'body' for sid in sources))
        self.assertIn('HIDDENABLATION', (out / 'packet.md').read_text())
        self.assertNotIn('UNMARKEDAPP', (out / 'packet.md').read_text())
        value['overrides'][0].update(first_source_id=sources[-1], last_source_id=sources[0])
        review.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'range'):
            prepare(self.pdf, self.root / 'reversed', scope=review)
        self.assertFalse((self.root / 'reversed').exists())

    def test_legacy_full_text_preparation_cannot_be_sent_to_writer(self):
        from reading_pipeline import value_hash
        from cpes_machine.writer import prepare_request
        for version in ('hint-reading-v1', 'hint-reading-v2'):
            old = dict(self.index)
            old['version'] = version
            old['fingerprint'] = value_hash({k: v for k, v in old.items() if k != 'fingerprint'})
            self.path.write_text(json.dumps(old))
            path = self.root / 'request.json'
            with self.assertRaisesRegex(ValueError, 'version changed'):
                prepare_request(self.path, path)
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
