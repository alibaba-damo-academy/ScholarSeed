"""Regression tests for model-facing citation identities."""
import json
import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'lib'), str(ROOT / 'scripts')]

from citation_identity import authoring_view, normalize_citations, require_evidence_references
from chapter_pipeline import chapter_messages
from chapter_plan import cards_plain


class CitationIdentityTest(unittest.TestCase):
    def test_reference_fields_close_over_local_evidence_and_literals_stay_literal(self):
        keys={'1':'One2024','2':'Two2024'}
        value={'analysis_tasks':[{'paper_ids':['2']}],'code':{'paper_ids':['1'],'text':r'\cite{Literal}'}}
        projected=authoring_view(value,keys)
        self.assertEqual(projected['code'],value['code'])
        with self.assertRaisesRegex(ValueError,'outside assigned evidence'):
            require_evidence_references(projected,{'One2024'})
        require_evidence_references(projected,{'One2024','Two2024'})
        with self.assertRaisesRegex(ValueError,'conflicting'):
            authoring_view({'paper_ids':['1'],'cite_keys':['Two2024']},keys)

    def test_source_identifiers_and_paths_are_not_authoring_evidence(self):
        record={'paperId':'987654321','paperhub_id':'8877665544','year':2024,
                'local_source':{'path':'/private/source.pdf','sha256':'source-digest'},
                'provenance':{'request_id':'internal-request'},
                'card':{'method':'A supported result with 3 conditions.'}}
        result=cards_plain(['987654321'],{'987654321':record},{'987654321':'Example2024'})
        self.assertIn('Example2024',result)
        self.assertIn('3 conditions',result)
        self.assertNotIn('8877665544',result)
        self.assertNotIn('/private/source.pdf',result)
        self.assertNotIn('internal-request',result)

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
