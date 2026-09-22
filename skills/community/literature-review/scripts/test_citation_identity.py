"""Regression tests for model-facing citation identities."""
import json
import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'lib'), str(ROOT / 'scripts')]

from citation_identity import authoring_view, normalize_citations
from chapter_pipeline import chapter_messages


class CitationIdentityTest(unittest.TestCase):
    def test_authoring_view_keeps_internal_ids_out_of_packet(self):
        keys = {'987654321': 'Example2024'}
        packet = {'chapter_ids': ['1'], 'assigned_paper_ids': ['987654321'],
                  'confirmed_full_outline': {'paper_ids': ['987654321']},
                  'evidence': '## Paper Example2024\nMethod: Supported result',
                  'related_papers': [{'paper_id': '987654321', 'title': 'Evidence'}],
                  'shared_tables': [], 'shared_figures': [], 'chapter_kind': 'component'}
        payload = json.loads(chapter_messages(packet, keys)[1]['content'])
        self.assertNotIn('987654321', json.dumps(payload))
        self.assertEqual(payload['assigned_cite_keys'], ['Example2024'])
        self.assertEqual(payload['confirmed_full_outline']['cite_keys'], ['Example2024'])
        self.assertEqual(payload['related_papers'][0]['cite_key'], 'Example2024')

    def test_only_exact_numeric_citation_ids_are_repaired(self):
        text = r'Year 2024; \citep{987654321,Other2023}; \citet{123}; \citep{9876543210}.'
        repaired, changes = normalize_citations(text, {'987654321': 'Example2024'})
        self.assertEqual(repaired, r'Year 2024; \citep{Example2024,Other2023}; \citet{123}; \citep{9876543210}.')
        self.assertEqual(changes, [('987654321', 'Example2024')])


if __name__ == '__main__':
    unittest.main()
