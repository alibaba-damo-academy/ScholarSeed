"""Display aliases must round-trip without changing source ownership or locators."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

from pdf_fixture import document_pdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from reading_pipeline import prepare, assemble, show


class SourceAliasTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        pdf = self.root / 'paper.pdf'
        document_pdf(pdf, [{'texts': [{'at': (40, 60), 'text': 'Literal source reference B00339 must remain unchanged.'}],
                            'marks': [{'phrases': ['source reference']}],
                            'notes': [{'at': (200, 90), 'text': 'My question about this method.'}]}])
        note = self.root / 'notes.md'
        note.write_text('A tentative personal idea.\n')
        prepare(pdf, self.root / 'reading', notes=[note])
        self.path = self.root / 'reading/reading.json'
        self.index = json.loads(self.path.read_text())

    def draft(self, short=False):
        ids = [s['id'] for s in self.index['catalog'] if s['record_ids']]
        if short:
            ids = [f'{s[0]}{int(s[1:]):03d}' for s in ids]
        return {'title': 'A connected note', 'sections': [{'title': 'Method', 'paragraphs': [
            {'text': 'The paragraph connects the method and the reader question.',
             'source_ids': ids[:1], 'identity': 'mixed', 'explanation': ''}]}],
            'omissions': [{'source_id': sid, 'reason': 'Outside this paragraph.'} for sid in ids[1:]]}

    def save_draft(self, name, draft):
        path = self.root / f'{name}.json'
        path.write_text(json.dumps(draft))
        return path

    def test_aliases_are_explicit_but_original_text_and_ids_remain_unchanged(self):
        self.assertIn('source_aliases', self.index)
        self.assertEqual(self.index['source_aliases']['A001'], 'A00001')
        packet = (self.path.parent / 'packet.md').read_text()
        self.assertIn('A001 → B001', packet)
        self.assertIn('@B001[', packet)
        self.assertIn('Literal source reference B00339 must remain unchanged.', packet)
        self.assertEqual(self.index['catalog'][0]['id'], 'B00001')

    def test_short_and_original_drafts_produce_identical_note_and_source_links(self):
        maps = []
        notes = []
        for name, short in [('original', False), ('short', True)]:
            out = self.root / name
            assemble(self.path, self.save_draft(name, self.draft(short)), out)
            maps.append(json.loads((out / 'source-map.json').read_text()))
            notes.append((out / 'note.md').read_bytes())
        self.assertEqual(notes[0], notes[1])
        for field in ('paragraphs', 'entries', 'omissions', 'records'):
            self.assertEqual(maps[0][field], maps[1][field])

    def test_mixed_short_and_original_duplicates_are_rejected(self):
        draft = self.draft()
        draft['sections'][0]['paragraphs'][0]['source_ids'] = ['A001', 'A00001']
        with self.assertRaisesRegex(ValueError, 'distinct'):
            assemble(self.path, self.save_draft('duplicate', draft), self.root / 'invalid')
        self.assertFalse((self.root / 'invalid').exists())

    def test_short_ids_can_retrieve_the_exact_original(self):
        result = show(self.path, ['B001'])
        self.assertEqual(result['sources'][0]['id'], 'B00001')
        self.assertIn('Literal source reference B00339', result['sources'][0]['text'])
        with self.assertRaisesRegex(ValueError, 'Unknown source'):
            show(self.path, ['B01'])

    def test_additional_sources_accept_aliases_without_duplicate_passages(self):
        from cpes_machine.writer import prepare_request, load_request
        request = self.root / 'request.json'
        prepare_request(self.path, request, sources=['B001', 'B00001'])
        value = load_request(request)
        self.assertEqual(value['additional_source_ids'], [])
        self.assertEqual(value['prompt'].count('Literal source reference B00339'), 1)


if __name__ == '__main__':
    unittest.main()
