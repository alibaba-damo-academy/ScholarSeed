"""Task-bound ID and label contracts; no models, network or user state."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from search_metadata_eligibility import bibliography_preflight
from citation_identity import normalize_outline, normalize_outline_ids
from retrieval.adapt_search_output import to_corpus_record, check_must_include, trim_to_size


class NormalizationTest(unittest.TestCase):
    def test_required_paper_identity_is_not_a_title_substring(self):
        request = {'constraints': [{'id': 'required', 'kind': 'must_include_paper',
                                    'value': {'title': 'A Study of Graphs'}}]}
        for title in ('Generalized A Study of Graphs', 'A Study of Graphs Revisited'):
            with self.subTest(title=title):
                self.assertFalse(check_must_include({'other': {'title': title}}, request)[0]['found'])
        self.assertTrue(check_must_include({'exact': {'title': 'A STUDY OF GRAPHS.'}}, request)[0]['found'])

    def test_quota_preserves_search_return_order_before_deduplication(self):
        records = {'other': {'title': 'Generalized A Study of Graphs', 'tier': 1},
                   'exact': {'title': 'A Study of Graphs', 'tier': 3}}
        request = {'retrieval': {'corpus_size': {'target': 1, 'max': 1}},
                   'constraints': [{'id': 'required', 'kind': 'must_include_paper',
                                    'value': {'title': 'A Study of Graphs'}}]}
        kept, trimmed = trim_to_size(records, request)
        self.assertEqual(set(kept), {'other'})
        self.assertEqual(trimmed, {'3': 1})
        self.assertEqual(len(records), 2)

    def test_required_identity_ambiguity_and_conflicting_quota_are_explicit(self):
        request = {'retrieval': {'corpus_size': {'target': 1}},
                   'constraints': [{'id': 'one', 'kind': 'must_include_paper',
                                    'value': {'title': 'Study One'}}]}
        records = {'a': {'title': 'Study One', 'tier': 1},
                   'b': {'title': 'Study One', 'tier': 2}}
        self.assertFalse(check_must_include(records, request)[0]['found'])
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            trim_to_size(records, request)
        records['b']['title'] = 'Study Two'
        request['constraints'].append({'id': 'two', 'kind': 'must_include_paper',
                                       'value': {'title': 'Study Two'}})
        with self.assertRaisesRegex(ValueError, 'ceiling'):
            trim_to_size(records, request)

    def test_outline_uses_current_mode_evidence_without_creating_cards(self):
        with tempfile.TemporaryDirectory() as directory:
            ws = Path(directory)
            for name in ('01_input', '02_retrieval', '03_process'):
                (ws / name).mkdir()
            selected = {'literature:a': {'title': 'Selected paper', 'abstract': 'Original abstract.'},
                        'literature:b': {'title': 'Other paper', 'abstract': 'Other abstract.'}}
            (ws / '02_retrieval/selected_paper.json').write_text(json.dumps(selected))
            request = ws / '01_input/writing_request.json'
            request.write_text(json.dumps({'execution': {'mode': 'quick'}}))
            value = {'paper_ids': ['a', 'b']}
            self.assertEqual(normalize_outline(ws, value)[0],
                             {'paper_ids': ['literature:a', 'literature:b']})
            cards = ws / '03_process/paper_cards.json'
            self.assertFalse(cards.exists())
            cards.write_text(json.dumps({'literature:a': {'paperId': 'literature:a'}}))
            request.write_text(json.dumps({'execution': {'mode': 'standard'}}))
            with self.assertRaisesRegex(ValueError, 'unknown'):
                normalize_outline(ws, value)
            self.assertEqual(normalize_outline(ws, {'paper_ids': ['a']})[0],
                             {'paper_ids': ['literature:a']})

    def test_author_conflict_does_not_hide_behind_upstream_bibtex(self):
        record = {'authors':['Jane Doe'], 'citationStyles':{'bibtex':'@article{x}'},
                  'author_metadata': {'raw':['Jane Doe'], 'alternatives': [
                      {'authors':['Janet Doe'], 'resolution':'needs_verification'}]}}
        result = bibliography_preflight({'p': record})
        self.assertEqual(result['issues'][0]['code'], 'AUTHOR_SOURCE_CONFLICT')
        record['author_metadata']['verification'] = {'method':'original page', 'source_revision':'sha256:paper'}
        self.assertEqual(bibliography_preflight({'p':record})['status'], 'SUCCESS')

    def test_unique_aliases_nested_fields_and_prose(self):
        selected = {'literature:a': {}, '123': {'library_refs': ['literature:b'], 'paperhub_id': 123}}
        value = {'description': 'a and literature:b remain prose', 'prerequisites': [{'paper_ids': ['a']}],
                 'outline_tree': [{'paper_ids': ['literature:b', 123], 'tables': [{'paper_ids': ['b']}]}]}
        before = deepcopy(value)
        result, changes = normalize_outline_ids(value, selected, set(selected))
        self.assertEqual(result['prerequisites'][0]['paper_ids'], ['literature:a'])
        self.assertEqual(result['outline_tree'][0]['paper_ids'], ['123', '123'])
        self.assertEqual(result['outline_tree'][0]['tables'][0]['paper_ids'], ['123'])
        self.assertEqual(len(changes), 4)
        self.assertEqual(value, before)
        self.assertEqual(normalize_outline_ids(result, selected, set(selected)), (result, []))
        self.assertEqual(result['description'], value['description'])

    def test_unknown_ambiguous_unselected_and_cite_keys_fail(self):
        selected = {'1': {'library_refs': ['literature:a']}, '2': {'library_refs': ['literature:a']},
                    '3': {'library_refs': ['literature:c']}}
        for token in ('a', 'c', 'Author2025', 'typo', True, {}, 1.0):
            with self.subTest(token=token), self.assertRaises(ValueError):
                normalize_outline_ids({'paper_ids': [token]}, selected, {'1', '2'})
        self.assertEqual(normalize_outline_ids({'paper_ids': ['1']}, selected, {'1', '2'})[0], {'paper_ids': ['1']})

    def test_scalar_and_array_topics_and_alternatives_survive_adapter(self):
        paper = {'title': 'Paper', 'authors': ['Ada'], 'metadata_alternatives': [{'field_group': 'authors'}]}
        for value, expected in [('reasoning', ['reasoning']), (['a', ' a ', '', 'b'], ['a', 'b']), (None, [])]:
            result = to_corpus_record('p', {**paper, 'subtopics_covered': value})
            self.assertEqual(result['subtopics_covered'], expected)
            self.assertEqual(result['metadata_alternatives'], paper['metadata_alternatives'])
        for bad in (False, 7, {'x': 'y'}, ['a', None]):
            with self.assertRaisesRegex(ValueError, 'subtopics_covered'):
                to_corpus_record('p', {**paper, 'subtopics_covered': bad})


if __name__ == '__main__': unittest.main()
