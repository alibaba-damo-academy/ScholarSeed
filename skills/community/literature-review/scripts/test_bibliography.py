"""Offline primary-metadata contracts; fixtures never count as product E2E."""

import asyncio
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import bibliography
import build_bib


class BibliographyTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.ws = Path(folder.name)
        self.paper = {'title': 'A bounded study', 'doi': '10.1000/study', 'year': 2023,
                      'authors': [{'name': 'Ada Author'}, {'name': 'Michael M. Researcher'}],
                      'journal': 'ArXiv', 'volume': 'abs/2301.00001',
                      'venue': {'name': 'A different container'}}
        self.metadata = {'title': 'A bounded study', 'DOI': '10.1000/study',
                         'author': [{'given': 'Ada', 'family': 'Author'}, {'given': 'Michael', 'family': 'Researcher'}],
                         'issued': {'date-parts': [[2025, 1, 2]]}, 'container-title': 'Actual Journal',
                         'volume': '33', 'page': '1-8'}

    def resolve(self, metadata=None, info=None):
        value = metadata if metadata is not None else self.metadata
        data = json.dumps(value).encode()
        with patch.object(bibliography, '_fetch', new=AsyncMock(return_value=(value, data, 'https://api.crossref.org/works/record'))) as fetch:
            report = asyncio.run(bibliography.resolve(self.ws, {'p': self.paper}, {'p': info or {}}))
        return report, fetch

    def test_verified_projection_keeps_middle_name_and_replaces_publication_group(self):
        original = copy.deepcopy(self.paper)
        report, fetch = self.resolve()
        self.assertEqual(report['items']['p']['status'], 'resolved')
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper)
        self.assertEqual(issues, [])
        self.assertEqual(projected['authors'][1]['given'], 'Michael M.')
        self.assertEqual(projected['authors'][1]['family'], 'Researcher')
        self.assertEqual(projected['year'], 2025)
        self.assertEqual(projected['journal'], 'Actual Journal')
        self.assertEqual(projected['volume'], '33')
        self.assertNotIn('venue', projected)
        self.assertRegex(projected['urldate'], r'^\d{4}-\d{2}-\d{2}$')
        self.assertEqual(self.paper, original)
        repeated, fetch = self.resolve()
        self.assertEqual(repeated['items']['p']['status'], 'reused')
        fetch.assert_not_called()

    def test_changed_selection_or_raw_response_cannot_reuse_verification(self):
        self.resolve()
        changed = {**self.paper, 'title': 'A different study'}
        with self.assertRaisesRegex(ValueError, 'binding_changed'):
            bibliography.project(self.ws, 'p', changed)
        source = next((self.ws / bibliography.DIRECTORY / 'responses').glob('*.json'))
        source.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'response_changed'):
            bibliography.project(self.ws, 'p', self.paper)
        report, fetch = self.resolve()
        self.assertEqual(report['items']['p']['status'], 'unresolved')
        fetch.assert_not_called()

    def test_verified_title_spelling_is_projected_without_changing_selected_identity(self):
        self.paper['title'] = r"R\'esum\'e of a bounded study"
        self.metadata['title'] = 'Résumé of a bounded study'
        original = copy.deepcopy(self.paper)
        self.resolve()
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper)
        self.assertEqual(projected['title'], 'Résumé of a bounded study')
        self.assertEqual(issues, [])
        self.assertEqual(self.paper, original)

    def test_publication_author_change_requires_bound_original_author_evidence(self):
        value = copy.deepcopy(self.metadata)
        value['author'].insert(1, {'given': 'Grace', 'family': 'Contributor'})
        info = {'parse_report': {'source_sha256': 'a' * 64, 'metadata_preview': {
            'kind': 'latex_title_author', 'title': self.paper['title'],
            'authors': 'Ada Author, Grace Contributor, Michael Researcher',
            'title_commands': 1, 'author_commands': 1, 'truncated': False}}}
        self.resolve(value, info)
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertEqual(issues, [])
        self.assertEqual(len(projected['authors']), 3)
        self.assertEqual(projected['year'], 2025)
        reduced, issues, _ = bibliography.project(self.ws, 'p', self.paper, {})
        self.assertIn('registration_author_group_preferred_over_selection', issues)
        self.assertEqual(len(reduced['authors']), 3)
        self.assertEqual(reduced['year'], 2025)
        self.assertEqual(reduced['journal'], 'Actual Journal')

    def test_material_growth_reuses_metadata_without_rewriting_lookup_context(self):
        self.resolve()
        path = bibliography._path(self.ws, 'p')
        before = path.read_bytes()
        info = {'actual_arxiv_id': '2401.00001v1',
                'parse_report': {'source_sha256': 'a' * 64}}
        report, fetch = self.resolve(info=info)
        self.assertEqual(report['items']['p']['status'], 'reused')
        fetch.assert_not_called()
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertEqual(issues, [])
        self.assertEqual(projected['year'], 2025)
        self.assertEqual(path.read_bytes(), before)

    def test_lost_source_proof_blocks_build_without_reusing_a_verified_author_group(self):
        value = copy.deepcopy(self.metadata)
        value['author'].insert(1, {'given': 'Grace', 'family': 'Contributor'})
        info = {'parse_report': {'source_sha256': 'a' * 64, 'metadata_preview': {
            'kind': 'latex_title_author', 'title': self.paper['title'],
            'authors': 'Ada Author, Grace Contributor, Michael Researcher',
            'title_commands': 1, 'author_commands': 1, 'truncated': False}}}
        self.resolve(value, info)
        retrieval = self.ws / '02_retrieval'
        retrieval.mkdir()
        (retrieval / 'selected_paper.json').write_text(json.dumps({'p': self.paper}))
        (retrieval / 'paper_info.json').write_text(json.dumps({'p': info}))
        report, status = build_bib.build(self.ws)
        self.assertEqual(status['status'], 'PARTIAL_SUCCESS')  # No cards in this pre-card fixture.
        self.assertIn('Contributor', Path(report['references_bib']).read_text())
        changed = copy.deepcopy(info)
        changed['parse_report']['metadata_preview']['authors'] = r'\unsupportedAuthorMacro{names}'
        (retrieval / 'paper_info.json').write_text(json.dumps({'p': changed}))
        failed = build_bib.build(self.ws)
        self.assertEqual(failed[1]['status'], 'PARTIAL_SUCCESS')
        self.assertIn('registration_author_group_preferred_over_selection', str(failed))

    def test_current_source_conflict_cannot_inherit_an_earlier_match(self):
        info = {'parse_report': {'source_sha256': 'a' * 64, 'metadata_preview': {
            'kind': 'latex_title_author', 'title': self.paper['title'],
            'authors': 'Ada Author, Michael Researcher', 'title_commands': 1,
            'author_commands': 1, 'truncated': False}}}
        self.resolve(info=info)
        changed = copy.deepcopy(info)
        changed['parse_report']['source_sha256'] = 'b' * 64
        changed['parse_report']['metadata_preview']['authors'] = 'Ada Author, Grace Contributor'
        _, issues, _ = bibliography.project(self.ws, 'p', self.paper, changed)
        self.assertIn('source_title_or_author_group_conflict', issues)
        matching, issues, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertEqual(issues, [])
        self.assertEqual(len(matching['authors']), 2)

    def test_arxiv_source_changes_recompute_version_and_date_verdict(self):
        self.paper['doi'] = '10.48550/arXiv.2401.00001'
        value = {**self.metadata, 'DOI': self.paper['doi'], 'version': '3'}
        self.resolve(value, {'actual_arxiv_id': '2401.00001v1'})
        path = bibliography._path(self.ws, 'p')
        before = path.read_bytes()
        for version, conflict, year in (('v3', False, 2025), ('v1', True, 2023)):
            current = {'actual_arxiv_id': '2401.00001' + version}
            projected, issues, _ = bibliography.project(self.ws, 'p', self.paper, current)
            self.assertEqual('registration_is_a_different_arxiv_version' in issues, conflict)
            self.assertEqual(projected['year'], year)
            self.assertEqual('urldate' in projected, not conflict)
        self.assertEqual(path.read_bytes(), before)

    def test_lookup_context_and_identifier_remain_integrity_checked(self):
        self.resolve()
        path = bibliography._path(self.ws, 'p')
        original = path.read_bytes()
        record = json.loads(original)
        record['source_binding'] = 'b' * 64
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'binding_changed'):
            bibliography.project(self.ws, 'p', self.paper)
        record = json.loads(original)
        record['lookup_doi'] = '10.1000/different'
        record['sha256'] = bibliography.digest({k: v for k, v in record.items() if k != 'sha256'})
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'identifier_conflict'):
            bibliography.project(self.ws, 'p', self.paper)
        record = json.loads(original)
        record['response_file'] = '../different.json'
        record['sha256'] = bibliography.digest({k: v for k, v in record.items() if k != 'sha256'})
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'response_reference_invalid'):
            bibliography.project(self.ws, 'p', self.paper)

    def test_pinned_source_without_a_registered_version_keeps_unknown_edition(self):
        self.paper['doi'] = '10.48550/arXiv.2401.00001'
        value = {**self.metadata, 'DOI': self.paper['doi']}
        info = {'actual_arxiv_id': '2401.00001v1'}
        for version in (None, '', 'unknown', 'version 3', 0):
            with self.subTest(version=version):
                projected, issues, matches = bibliography._projection(self.paper, info, {**value, 'version': version})
                self.assertIn('registration_arxiv_version_unverified', issues)
                self.assertFalse(matches)
                self.assertEqual(projected['year'], 2023)
        self.resolve(value, info)
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertNotIn('urldate', projected)
        self.assertEqual(projected['arxiv_id'], '2401.00001v1')
        observed = {**info, 'parse_report': {'source_sha256': 'a' * 64},
                    'source_access': {'kind': 'original_source_consultation',
                                      'source_sha256': 'a' * 64, 'at': '2024-01-03T12:00:00+00:00'}}
        projected, _, _ = bibliography.project(self.ws, 'p', self.paper, observed)
        self.assertEqual(projected['urldate'], '2024-01-03')
        self.assertEqual(projected['year'], 2023)

    def test_different_arxiv_version_does_not_supply_a_pinned_access_date(self):
        self.paper['doi'] = '10.48550/arXiv.2401.00001'
        value = {**self.metadata, 'DOI': self.paper['doi'], 'version': '3'}
        info = {'actual_arxiv_id': '2401.00001v1'}
        self.resolve(value, info)
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertIn('registration_is_a_different_arxiv_version', issues)
        self.assertNotIn('urldate', projected)
        self.assertEqual(projected['year'], 2023)

    def test_original_consultation_date_requires_matching_revision_and_observed_time(self):
        info = {'parse_report': {'source_sha256': 'a' * 64}, 'source_access': {
            'kind': 'original_source_consultation', 'source_sha256': 'a' * 64,
            'at': '2026-10-29T23:00:00+00:00'}}
        result, _, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertEqual(result['urldate'], '2026-10-29')
        info['source_access']['source_sha256'] = 'b' * 64
        result, _, _ = bibliography.project(self.ws, 'p', self.paper, info)
        self.assertNotIn('urldate', result)
        result, _, _ = bibliography.project(self.ws, 'p', self.paper)
        self.assertNotIn('urldate', result)

    def test_source_group_verification_cannot_drop_or_split_an_extra_author(self):
        paper = {**self.paper, 'authors': []}
        value = copy.deepcopy(self.metadata)
        value['author'] = [{'given': 'Ada', 'family': 'Author'}]
        for authors in ('Ada Author and Eve Other', 'WrongAda Author', 'Ada, Author'):
            info = {'parse_report': {'source_sha256': 'a' * 64, 'metadata_preview': {
                'kind': 'latex_title_author', 'title': paper['title'], 'authors': authors,
                'title_commands': 1, 'author_commands': 1, 'truncated': False}}}
            with self.subTest(authors=authors):
                projected, issues, _ = bibliography._projection(paper, info, value)
                self.assertEqual(len(projected['authors']), 1 if authors == 'Ada, Author' else 0)
                expected = ('registration_author_group_preferred_over_selection' if authors == 'Ada, Author'
                            else 'source_title_or_author_group_conflict')
                self.assertIn(expected, issues)
                self.assertEqual(projected['year'], 2025 if authors == 'Ada, Author' else 2023)

    def test_matching_selected_metadata_cannot_bypass_a_complete_source_conflict(self):
        paper = {**self.paper, 'authors': [{'name': 'Ada Author'}]}
        value = {**self.metadata, 'author': [{'given': 'Ada', 'family': 'Author'}]}
        preview = {'kind': 'latex_title_author', 'title': paper['title'],
                   'authors': 'Ada Author and Eve Other', 'title_commands': 1,
                   'author_commands': 1, 'truncated': False}
        info = {'parse_report': {'source_sha256': 'a' * 64, 'metadata_preview': preview}}
        projected, issues, _ = bibliography._projection(paper, info, value)
        self.assertIn('source_title_or_author_group_conflict', issues)
        self.assertEqual(projected['year'], 2023)
        preview['authors'] = r'\unknown{Ada Author and Eve Other}'
        state, _ = bibliography.assess_source(paper, info, value)
        self.assertEqual(state, 'unverified')

    def test_quick_binding_never_opens_original_or_l1_information(self):
        (self.ws / '01_input').mkdir()
        (self.ws / '02_retrieval').mkdir()
        (self.ws / '01_input/writing_request.json').write_text(json.dumps({'execution': {'mode': 'quick'}}))
        (self.ws / '02_retrieval/paper_info.json').write_text('RAW_L1_MUST_NOT_BE_PARSED')
        self.assertEqual(bibliography.read_information(self.ws), {})
        self.resolve(info=bibliography.read_information(self.ws))
        projected, _, _ = bibliography.project(self.ws, 'p', self.paper, bibliography.read_information(self.ws))
        self.assertEqual(projected['year'], 2025)

    def test_missing_registered_authors_retains_selection_and_identifier(self):
        value = {key: val for key, val in self.metadata.items() if key != 'author'}
        original = copy.deepcopy(self.paper)
        self.resolve(value)
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper)
        self.assertEqual(projected['authors'], original['authors'])
        self.assertEqual(projected['doi'], original['doi'])
        self.assertEqual(projected['year'], 2025)
        self.assertIn('registration_authors_unavailable_retained_selection', issues)
        self.assertEqual(self.paper, original)

    def test_registration_resolves_spelling_without_mutating_frozen_selection(self):
        self.paper['authors'] = [{'name': 'Ada M. Author'}, {'name': 'M. R. Researcher'}]
        original = copy.deepcopy(self.paper)
        self.resolve()
        projected, issues, _ = bibliography.project(self.ws, 'p', self.paper)
        self.assertEqual(projected['authors'][1]['name'], 'Michael Researcher')
        self.assertIn('registration_author_group_preferred_over_selection', issues)
        self.assertEqual(self.paper, original)

    def test_incomplete_publication_group_does_not_mix_registration_fields(self):
        value = {key: val for key, val in self.metadata.items() if key != 'issued'}
        self.resolve(value)
        projected, issues, entry_type = bibliography.project(self.ws, 'p', self.paper)
        for field in ('year', 'journal', 'volume', 'venue'):
            self.assertEqual(projected[field], self.paper[field])
        self.assertIsNone(entry_type)
        self.assertIn('registration_publication_group_incomplete_retained_selection', issues)

    def test_metadata_counts_include_redirects_and_cache_reuse(self):
        client_type = httpx.AsyncClient
        requests = []

        def respond(request):
            requests.append(request)
            self.assertNotIn('authorization', request.headers)
            if request.url.host == 'doi.org':
                return httpx.Response(302, headers={'location': 'https://api.crossref.org/works/record'})
            return httpx.Response(200, json=self.metadata)

        def client(**kwargs):
            return client_type(**kwargs, transport=httpx.MockTransport(respond))

        with patch.object(bibliography.httpx, 'AsyncClient', side_effect=client):
            report = asyncio.run(bibliography.resolve(self.ws, {'p': self.paper}))
            reused = asyncio.run(bibliography.resolve(self.ws, {'p': self.paper}))
        self.assertEqual(report['metadata_request_attempts'], 2)
        self.assertEqual(report['metadata_redirects'], 1)
        self.assertEqual(report['metadata_responses'], 2)
        self.assertEqual(reused['metadata_request_attempts'], 0)
        self.assertEqual(len(requests), 2)

    def test_unrelated_title_and_internal_alias_are_not_accepted_identifiers(self):
        report, _ = self.resolve({**self.metadata, 'title': 'A study of something else'})
        self.assertEqual(report['items']['p']['status'], 'unresolved')
        self.assertFalse(bibliography._path(self.ws, 'p').exists())
        with patch.object(bibliography, '_fetch', new=AsyncMock()) as fetch:
            report = asyncio.run(bibliography.resolve(self.ws, {'10.1000/fake': {'title': 'No identifier'}}))
        fetch.assert_not_called()
        self.assertEqual(report['items']['10.1000/fake']['status'], 'not_available')
        with self.assertRaisesRegex(ValueError, 'identifier_conflict'):
            bibliography.identifier({'doi': '10.48550/arXiv.2401.00001', 'arxiv_id': '2401.00002'})

    def test_verified_conference_type_is_explicit_and_not_a_venue_guess(self):
        value = {**self.metadata, 'type': 'proceedings-article', 'container-title': 'Actual Proceedings'}
        self.resolve(value)
        projected, _, entry_type = bibliography.project(self.ws, 'p', self.paper)
        self.assertEqual(entry_type, 'InProceedings')
        self.assertEqual(projected['booktitle'], 'Actual Proceedings')
        self.assertNotIn('journal', projected)

    def test_metadata_redirects_are_anonymous_and_never_follow_a_paper_pdf(self):
        client_type = httpx.AsyncClient
        requests = []

        def respond(request):
            requests.append(request)
            self.assertNotIn('authorization', request.headers)
            return httpx.Response(302, headers={'location': 'https://publisher.example/paper.pdf'})

        def client(**kwargs):
            return client_type(**kwargs, transport=httpx.MockTransport(respond))

        with patch.object(bibliography.httpx, 'AsyncClient', side_effect=client):
            with self.assertRaisesRegex(ValueError, 'redirect_not_allowed'):
                asyncio.run(bibliography._fetch('10.1000/study'))
        self.assertEqual(len(requests), 1)


if __name__ == '__main__':
    unittest.main()
