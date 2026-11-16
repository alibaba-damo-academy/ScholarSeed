"""Content-only reuse of framework-owned reading assets."""
import json
import pathlib
import tempfile
import unittest

from authoring import writing_content
from reading import BUNDLE_SCHEMA, import_assets, load, sha
from task_contract import atomic_json

def asset(depth="partial"):
    content = "#1 原文的结果及条件。\n#2 | metric | value |\n  | score | 21 |"
    return {
        "literature_id": "doc",
        "attachment_id": "attachment",
        "revision": "abc",
        "l1": {
            "docId": "doc",
            "title": "论文",
            "paper_type": "method",
            "reading_depth": depth,
            "card": {"experiments": {"results": [{"metric": "score", "value": 21}]}},
            "common_fields": {"tldr": "中文简述", "claims": [{"text": "有条件的结论"}]},
            "extraction_quality": {"status": "READY"},
            "completeness": {"complete": True},
        },
        "metadata": {
            "schema_version": "l1-reading/v2",
            "extractor_version": "0.2.4",
            "prompt_version": "l1/v2.4",
            "coverage": {
                "complete": depth == "full",
                "unavailable_pages": [] if depth == "full" else [3],
            },
        },
        "source_snapshot": {
            "source_revision": "sha256:abc",
            "input_sha256": sha(content),
            "fragments": {
                "1": {"text": "原文的结果及条件。", "kind": "paragraph", "pages": [{"page": 1}]},
                "2": {
                    "text": "| metric | value |\n| score | 21 |",
                    "kind": "table_text",
                    "pages": [{"page": 2}],
                },
            },
            "images": {},
        },
        "source_mapping": {
            "docId": "doc",
            "card_mapping": {"card.experiments.results[0]": [1, 2], "common_fields.claims[0]": [1]},
            "sentences": {"1": "原文的结果及条件。", "2": "| metric | value |\n| score | 21 |"},
        },
    }


class ReadingContract(unittest.TestCase):
    def test_reuse_has_no_local_mapping_or_raw_asset_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = pathlib.Path(folder) / 'survey'
            selected = {'p': {'title': '论文', 'abstract': '摘要', 'year': 2026}}
            atomic_json(ws/'02_retrieval/selected_paper.json', selected)
            atomic_json(ws/'.slr-binding.json', {'run_id': 'run'})
            atomic_json(ws/'02_retrieval/reading_assets.json', {
                'schema': BUNDLE_SCHEMA, 'workspace': 'survey', 'run_id': 'run',
                'selection_json': json.dumps(selected), 'assets': {'p': asset()}, 'misses': {}})
            report = import_assets(ws)
            self.assertEqual(report['reused_count'], 1)
            card = load(ws/'03_process/paper_cards.json', {})['p']
            self.assertEqual(card['asset_revision'], 'abc')
            self.assertFalse((ws/'03_process/source_maps.json').exists())
            self.assertFalse((ws/'03_process/reading').exists())
            view = writing_content(card)
            self.assertNotIn('source_ids', json.dumps(view))
            self.assertNotIn('source_snapshot', view)

if __name__ == '__main__':
    unittest.main()
