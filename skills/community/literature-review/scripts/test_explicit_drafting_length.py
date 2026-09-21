#!/usr/bin/env scholarseed-skill-python
"""No inferred quotas; explicit document constraints survive legacy drafting."""
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts/generation/_fast'))
sys.path.insert(0, str(ROOT / 'scripts/generation/drafting/_fast'))
import test_writing as fixtures
from validate_drafts import document_length_check
from writing_contract import explicit_length_budget
from manuscript_publication import publish


class ExplicitLengthTest(unittest.TestCase):
    def test_explicit_unit_aliases_and_unknown_unit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / '01_input').mkdir()
            from task_fixtures import task
            req = root / '01_input/writing_request.json'
            for unit in ('words','cjk_chars','characters','pages'):
                req.write_text(json.dumps(task({'length_min':6,'length_unit':unit})))
                self.assertEqual(explicit_length_budget(root)['unit'],unit)
            req.write_text(json.dumps({**task(),'length_unit':'mystery'}))
            with self.assertRaisesRegex(ValueError,'invalid length_unit'): explicit_length_budget(root)
        self.assertEqual(document_length_check(['a b 中文'], {'unit': 'characters', 'min': 4, 'max': 4})['violations'], [])

    def test_short_valid_deliverable_has_no_inferred_size_floor(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            from task_fixtures import task
            from task_contract import atomic_json
            atomic_json(root/'01_input/writing_request.json',task())
            (root/'05_generation').mkdir()
            doc = root / '05_generation/full_draft_v2.md'
            doc.write_text('# Methods\n\nConditional assumptions matter.\n')
            report = publish(root)
            self.assertEqual(report['status'], 'SUCCESS')
            self.assertEqual((root/'06_output/survey.md').read_text(),doc.read_text())

    def test_target_is_not_an_invented_range(self):
        report = document_length_check(['Evidence supports conditional guarantees.'],
                                       {'unit': 'words', 'target': 12000, 'source': 'user'})
        self.assertEqual(report['violations'], [])
        self.assertNotIn('min', report['budget'])
        self.assertNotIn('max', report['budget'])

    def test_explicit_bounds_cover_whole_output(self):
        budget = {'unit': 'words', 'min': 5, 'max': 7, 'source': 'user'}
        self.assertEqual(document_length_check(['one two three', 'four five six'], budget)['violations'], [])
        self.assertIn('below', document_length_check(['one two'], budget)['violations'][0])
        self.assertIn('above', document_length_check(['one two three four five six seven eight'], budget)['violations'][0])
        self.assertEqual(document_length_check(['证据需要比较'], {'unit': 'cjk_chars', 'min': 6})['violations'], [])

    def test_pages_are_not_converted_to_words(self):
        report = document_length_check(['Short text.'], {'unit': 'pages', 'min': 10})
        self.assertIn('deferred', report)
        self.assertNotIn('measured', report)

    def test_legacy_section_target_does_not_reintroduce_stub_floor(self):
        fixture = fixtures.WritingTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        path = fixture.ws / '05_generation/_internal/drafting_worklist.json'
        work = json.loads(path.read_text())
        work['items'][0].update(length_target='10000–20000 words', length_min=10000)
        path.write_text(json.dumps(work))
        fixture.put('05_generation/section_drafts/3.json', {
            'section_id': '3', 'title': 'Methods',
            'body_md': 'Conditional guarantees differ under the two assumptions [@First2024].',
            'claims': [], 'insights': []})
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/generation/drafting/_fast/validate_drafts.py'),
                                 str(fixture.ws), '--only', '3'], capture_output=True, text=True)
        report = json.loads((fixture.ws / '05_generation/_status/validate_drafts.json').read_text())
        self.assertEqual(report['invalid'], [], result.stdout + result.stderr)
        self.assertEqual(report['drafted'], 1)
        fixture.put('05_generation/section_drafts/3.json', {'body_md': '   '})
        subprocess.run([sys.executable, str(ROOT / 'scripts/generation/drafting/_fast/validate_drafts.py'),
                        str(fixture.ws), '--only', '3'], capture_output=True, text=True)
        report = json.loads((fixture.ws / '05_generation/_status/validate_drafts.json').read_text())
        self.assertIn('empty', report['invalid'][0]['error'])

    def test_preparation_has_no_default_or_distributed_quotas(self):
        fixture = fixtures.WritingTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.put('01_input/requirements.json', {
            'req_normal': {'language': 'english', 'length': {'scale': 'standard', 'target': 7200}},
            'req_special': []})
        fixture.prep()
        base = fixture.ws / '05_generation/_internal'
        work = json.loads((base / 'drafting_worklist.json').read_text())
        self.assertFalse(work['length_budget'])
        quota_keys = {'length_target', 'length_min', 'length_max', 'bridge_target'}
        for item in work['items']:
            self.assertFalse(quota_keys.intersection(item))
            for sub in item.get('subsections', []):
                self.assertFalse(quota_keys.intersection(sub))
        fixture.put('01_input/writing_request.json', {'length_target': 12000, 'length_min': 10800})
        fixture.prep()
        work = json.loads((base / 'drafting_worklist.json').read_text())
        self.assertEqual(work['length_budget']['target'], 12000)
        self.assertEqual(work['length_budget']['min'], 10800)
        for item in work['items']:
            self.assertFalse(quota_keys.intersection(item))
            packet = json.loads((base / 'drafting_items' / (item['section_id'] + '.json')).read_text())
            self.assertEqual(packet['document_length_budget']['target'], 12000)


if __name__ == '__main__':
    unittest.main()
