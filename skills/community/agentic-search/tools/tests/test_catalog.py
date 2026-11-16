"""Offline metadata-group and normalization regressions."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Skill test bootstrap.
from catalog import labels
from dedup import merge_records
from finalize import _hydrate


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.local = {'paper_id': 'literature:x', 'source': 'project_library', 'title': 'Paper',
                      'library_refs': ['literature:x'], 'authors': ['Robert Lange'],
                      'author_metadata': {'raw': ['Robert Lange'], 'source': 'project_library', 'format': 'structured'},
                      'doi': '10.1/x', 'arxiv_id': '2501.00001', 'year': 2025,
                      'venue': 'Robotics', 'bib_type': 'misc'}
        self.hub = {'paper_id': '123', 'paperhub_id': '123', 'source': 'paperhub', 'title': 'Paper',
                    'authors': ['R. Lange'], 'doi': '10.1/x', 'year': 2025,
                    'journal_name': 'Journal of Research', 'journal_volume': '3',
                    'publication_types': ['JournalArticle']}

    def test_source_groups_identity_and_idempotence(self):
        before = deepcopy((self.local, self.hub))
        for left, right in ((self.local, self.hub), (self.hub, self.local)):
            merged = merge_records(left, right)
            self.assertEqual(merged['paper_id'], '123')
            self.assertEqual(merged['library_refs'], ['literature:x'])
            self.assertEqual(merged['arxiv_id'], '2501.00001')
            self.assertEqual(merged['authors'], ['Robert Lange'])
            self.assertEqual(merged['author_metadata']['raw'], merged['authors'])
            self.assertEqual(merged['author_metadata']['source'], 'project_library')
            self.assertEqual(merged['journal_name'], 'Journal of Research')
            self.assertNotIn('bib_type', merged)
            self.assertNotIn('venue', merged)
            self.assertEqual(merged, merge_records(merged, self.hub))
            alternatives = merged['author_metadata']['alternatives']
            self.assertEqual(alternatives[0]['resolution'], 'equivalent_display')
        self.assertEqual((self.local, self.hub), before)

    def test_missing_authors_and_verified_remote_group(self):
        for local in ({**self.local, 'authors': [], 'author_metadata': {}}, self.local):
            hub = deepcopy(self.hub)
            hub['author_metadata'] = {'raw': hub['authors'], 'source': 'original_pdf',
                                      'verification': {'method': 'title page', 'source_revision': 'sha256:abc'}}
            merged = merge_records(local, hub)
            self.assertEqual(merged['authors'], hub['authors'])
            self.assertEqual(merged['author_metadata']['source'], hub['author_metadata']['source'])
            self.assertEqual(merged['author_metadata']['verification'], hub['author_metadata']['verification'])

    def test_real_conflict_is_preserved_and_stale_proof_not_reassigned(self):
        hub = {**self.hub, 'authors': ['Shen Yin']}
        merged = merge_records(self.local, hub)
        self.assertEqual(merged['author_metadata']['alternatives'][0]['resolution'], 'needs_verification')
        local = deepcopy(self.local)
        local['author_metadata']['raw'] = ['Different Person']
        local['author_metadata']['verification'] = {'method': 'title page', 'source_revision': 'sha256:old'}
        merged = merge_records(local, hub)
        self.assertNotIn('verification', merged['author_metadata'])
        self.assertEqual(merged['author_metadata']['raw'], local['authors'])
        self.assertIn('previous_annotation', merged['author_metadata'])

    def test_provider_bibtex_cannot_override_chosen_authors(self):
        self.hub['citationStyles'] = {'bibtex': '@article{x, author={R. Lange}}'}
        merged = merge_records(self.local, self.hub)
        self.assertNotIn('bibtex', merged['citationStyles'])
        self.assertEqual(merged['author_metadata']['retained_upstream_bibtex']['bibtex'], self.hub['citationStyles']['bibtex'])

    def test_same_edition_can_fill_publication_fields(self):
        self.local.update(journal_name='Journal of Research', pages='1-8')
        merged = merge_records(self.hub, self.local)
        self.assertEqual(merged['pages'], '1-8')

    def test_labels_and_finalizer_never_split_characters(self):
        self.assertEqual(labels('  reasoning  '), ['reasoning'])
        self.assertEqual(labels('one,two'), ['one,two'])
        self.assertEqual(labels(['a', '', ' a ', 'b']), ['a', 'b'])
        for bad in (1, {}, ['x', 2]):
            with self.assertRaises(ValueError): labels(bad)
        rows, _ = _hydrate([{'paper_id': '123', 'subtopics_covered': 'reasoning'}], {'123': self.hub})
        self.assertEqual(rows[0]['subtopics_covered'], ['reasoning'])


if __name__ == '__main__': unittest.main()
