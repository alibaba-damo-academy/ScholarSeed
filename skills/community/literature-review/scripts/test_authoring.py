"""Offline invariants for the common fresh-card / saved-L1 writing interface."""

import copy
import unittest

from authoring import authoring_card, writing_content


class AuthoringTest(unittest.TestCase):
    def test_source_snapshots_stay_local_without_changing_business_content(self):
        record={'title':'Paper','card':{'method':'A method'},'abstract':'Original abstract',
                'source_statements':{'sentences':{'1':'Repeated original text'}},
                'source_context':{'included':[{'text':'Repeated page text'}]}}
        before=copy.deepcopy(record)
        view=authoring_card(record)
        self.assertEqual(view['card'],record['card'])
        self.assertEqual(view['abstract'],record['abstract'])
        self.assertNotIn('source_statements',view)
        self.assertNotIn('source_context',view)
        self.assertEqual(record,before)



    def test_same_business_content_despite_different_material_provenance(self):
        fresh = {
            "title": "Paper",
            "year": 2024,
            "paper_type": "method",
            "reading_depth": "full",
            "abstract": "Abstract",
            "card": {
                "method": {"formula": "x <= y, only if z > 0"},
                "experiments": {"value": 21, "unit": "%", "labels": 40},
            },
            "common_fields": {"limitations": ["Only evaluated on dataset D"]},
        }
        saved = {
            **copy.deepcopy(fresh),
            "source_evidence": {
                "field_sources": {"card.experiments": [1]},
                "sentences": {"1": "RAW" * 5000},
            },
            "reading_asset": {"sha256": "receipt"},
            "source_text_sha256": "hash",
        }
        before = copy.deepcopy(saved)
        self.assertEqual(authoring_card(fresh), authoring_card(saved))
        self.assertEqual(writing_content(fresh), writing_content(saved))
        self.assertEqual(saved, before)

    def test_unknown_business_fields_and_qualifications_are_not_recursively_filtered(self):
        record = {
            "card": {
                "new_result": {
                    "source_path": "research variable",
                    "source_maps": "mathematical mapping",
                    "quads": [1, 2, 3, 4],
                }
            },
            "common_fields": {"condition": "under assumption A only"},
        }
        result = writing_content(record)
        self.assertEqual(result, record)
        result["card"]["new_result"]["quads"].append(5)
        self.assertEqual(record["card"]["new_result"]["quads"], [1, 2, 3, 4])

    def test_quarantine_and_image_limits_survive_without_raw_inventory(self):
        record = {
            "card": {"method": "Supported independent method"},
            "evidence_validation": {
                "quarantined_groups": ["card.experiments"],
                "semantic_adequacy": "question_dependent",
                "source_verification": "current_pdf_revision",
                "images": {"3": {"state": "link_conflict"}},
            },
            "source_coverage": {"complete": False, "omissions": [{"page": 3}] * 500},
            "source_evidence": {"images": {"5": {"label": "Raw caption"}}},
        }
        result = authoring_card(record)
        self.assertNotIn('Evidence limits', result)
        self.assertNotIn('quarantined_groups', str(result))
        self.assertNotIn("Raw caption", str(result))
        self.assertNotIn("source_coverage", result)

    def test_material_status_does_not_change_the_writing_view(self):
        record = {
            'title': 'Paper', 'abstract': 'Original abstract',
            'card': {'conclusion': 'Valid only under assumption A'},
            'common_fields': {'limitations': ['Only evaluated on dataset D']},
        }
        expected = authoring_card(record)
        for depth in ('full', 'abstract_only'):
            material = {**copy.deepcopy(record), 'reading_depth': depth,
                        'source_coverage': {'complete': False}}
            before = copy.deepcopy(material)
            self.assertEqual(authoring_card(material), expected)
            self.assertEqual(material, before)
