"""Compact evidence must preserve wording, uncertain links and local provenance."""
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

from pdf_fixture import document_pdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from reading_pipeline import prepare, resolve


class CompactPacketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.pdf = root / 'paper.pdf'
        self.note = root / 'note.md'
        self.note.write_text('My tentative research idea.\n')
        document_pdf(self.pdf, [
            {'texts': [
                {'at': (40, 50), 'text': 'Methods', 'bold': True, 'size': 14},
                {'at': (40, 100), 'text': 'The sampler is memory efficient and represents uncertainty.'},
                {'at': (40, 140), 'text': 'See Supplement B and Supplementary Information for the training procedure.'},
                {'at': (40, 190), 'text': 'The objective combines two terms; theta denotes the parameters.'},
                {'at': (45, 225), 'text': 'E'}, {'at': (70, 250), 'text': '='},
                {'at': (100, 275), 'text': 'L'}, {'at': (140, 300), 'text': '(2)'},
                {'at': (40, 340), 'text': 'Repeated phrase. Repeated phrase.'}],
             'marks': [{'phrases': [phrase]} for phrase in ('The sampler is', 'memory efficient', 'Repeated phrase.',
                       'The objective combines two terms; theta denotes the parameters.')],
             'notes': [{'at': (180, 220), 'text': 'Do I need to master this?'}]},
            {'texts': [
                {'at': (40, 50), 'text': 'Appendix A', 'bold': True, 'size': 14},
                {'at': (40, 400), 'text': 'Extended Data Fig. 1 | Architecture. On the right'},
                {'at': (320, 400), 'text': 'are the remaining layers and their connections.'},
                {'at': (40, 500), 'text': 'UNRELATEDAPP should remain local.'}],
             'marks': [{'phrases': ['Architecture']}]}], size=(600, 800))
        self.out = root / 'reading'
        prepare(self.pdf, self.out, notes=[self.note])
        self.index = json.loads((self.out / 'reading.json').read_text())
        self.packet = (self.out / 'packet.md').read_text()

    def test_shared_original_is_not_repeated_as_full_mark_text(self):
        original = 'The sampler is memory efficient and represents uncertainty.'
        self.assertEqual(self.packet.count(original), 1)
        self.assertIn('packet_view', self.index)
        signals = self.index['packet_view']['signals']
        anchored = [s for s in signals if s['anchors']]
        self.assertGreaterEqual(len(anchored), 3)
        for signal in anchored:
            for anchor in signal['anchors']:
                original = resolve(self.index, anchor['source_id'])['text']
                self.assertEqual(original[anchor['start']:anchor['end']], anchor['text'])
                self.assertEqual(original.count(anchor['quote']), 1)
        self.assertNotIn('"channels"', self.packet)
        self.assertNotIn('"rects"', self.packet)
        self.assertIn('My tentative research idea.', self.packet)

    def test_caption_continuation_is_retrieved_without_unrelated_appendix(self):
        self.assertIn('are the remaining layers and their connections.', self.packet)
        self.assertNotIn('UNRELATEDAPP', self.packet)
        captions = [u for u in self.index['packet_view']['units'] if u['kind'] == 'caption']
        self.assertEqual(len(captions), 1)
        self.assertGreaterEqual(len(captions[0]['source_ids']), 1)
        self.assertTrue(captions[0]['text'].endswith('connections.'))

    def test_formula_fragments_are_grouped_but_never_declared_verified(self):
        units = [u for u in self.index['packet_view']['units'] if u['kind'] == 'formula_fragments']
        self.assertEqual(len(units), 1)
        self.assertGreaterEqual(len(units[0]['source_ids']), 3)
        self.assertFalse(units[0]['verified'])
        for sid in units[0]['source_ids']:
            original = resolve(self.index, sid)['text']
            self.assertIn(original, units[0]['text'])
        self.assertIn('Do I need to master this?', self.packet)
        self.assertTrue(any(s['association'] == 'spatial_candidate' for s in self.index['packet_view']['signals']))

    def test_supplement_and_visual_status_do_not_claim_complete_coverage(self):
        self.assertIn('Supplement B', self.packet)
        self.assertIn('未核实', self.packet)
        self.assertIn('未执行', self.packet)
        self.assertNotIn('Unresolved cross-references: []', self.packet)
        self.assertEqual(self.index['packet_view']['supplement_references'],
                         ['Supplement B', 'Supplementary Information'])
        self.assertEqual(re.findall(r'^# (.+)$', self.packet, flags=re.M),
                         ['论文与材料状态', '阅读标记', '原文证据'])

    def test_reading_signals_lead_with_full_text_and_context_backlinks(self):
        marks, body = self.packet.split('# 阅读标记', 1)[1].split('# 原文证据', 1)
        self.assertIn('The objective combines two terms; theta denotes the parameters.', marks)
        self.assertIn('Do I need to master this?', marks)
        self.assertIn('My tentative research idea.', marks)
        self.assertIn('对应阅读标记：', body)
        self.assertIn('A', body.split('对应阅读标记：', 1)[1].splitlines()[0])

    def test_every_selected_original_has_an_exact_local_unit_mapping(self):
        seen = []
        for unit in self.index['packet_view']['units']:
            for sid, span in unit['source_ranges'].items():
                self.assertEqual(unit['text'][span[0]:span[1]], resolve(self.index, sid)['text'])
                seen.append(sid)
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(set(seen), set(self.index['packet_selection']['source_ids']))

    def test_repeated_mark_text_is_not_given_a_fabricated_unique_anchor(self):
        source = next(s for s in self.index['catalog'] if s['record_ids'] and
                      resolve(self.index, s['id'])['text'] == 'Repeated phrase.')
        signal = next(s for s in self.index['packet_view']['signals'] if s['source_id'] == source['id'])
        self.assertEqual(signal['anchors'], [])
        self.assertTrue(signal['context_ids'])
        line = next(line for line in self.packet.splitlines() if line.startswith(f"{source['id'][0]}{int(source['id'][1:]):03d} →"))
        self.assertIn('候选', line)
        self.assertIn('Repeated phrase.', line)


if __name__ == '__main__':
    unittest.main()
