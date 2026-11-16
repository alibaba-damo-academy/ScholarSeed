"""Prepared-source import, budget and freeze contracts without a model."""

import contextlib
import io
from types import SimpleNamespace
import slr
import pdf_fixture
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'lib'), str(ROOT / 'scripts')]

from local_papers import budget, load_local
from materials import import_materials
from task_contract import atomic_json, configure, digest, read_request
from workspace_binding import bind
from workflow import resume_guard


class PreparedContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ws = self.root / 'survey'
        self.refs = ['literature:' + str(index) for index in range(5)]
        self.previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.previous)
        configure(self.ws, {'intent': 'Compare the supplied papers.', 'execution': {'mode': 'quick'},
                  'sources': {'policy': 'supplement', 'refs': self.refs}, 'outline_review': 'plan',
                  'publication': {'format': 'markdown'}, 'retrieval': {'corpus_size': {'target': 6}}})
        bind(self.ws, ROOT)
        self.run_id = 'slr-' + hashlib.sha256(b'survey').hexdigest()[:16]

    def test_plan_command_consumes_batch_once_and_preserves_pending_selection(self):
        response = self.response(self.manifest(ready=3))
        payload = (json.dumps({'schema': 'task-receipt/v1', 'operation': 'task.activate',
                              'workspace': 'survey', 'run_id': self.run_id, 'response': response},
                             ensure_ascii=False, sort_keys=True) + '\n').encode()
        path = self.ws / '_status/product_receipts' / (hashlib.sha256(payload).hexdigest() + '.json')
        path.parent.mkdir(parents=True)
        path.write_bytes(payload)
        before = read_request(self.ws)
        args = SimpleNamespace(action='plan-packet', plan_action=None, patch=None,
                               workspace=str(self.ws), request=None,
                               receipt=path.relative_to(self.root).as_posix(), full=True)
        results = []
        for _ in range(2):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(slr.cmd_writing(args), 0)
            results.append(json.loads(output.getvalue()))
        self.assertEqual(results[0]['packet_id'], results[1]['packet_id'])
        self.assertEqual(read_request(self.ws), before)
        self.assertEqual(budget(self.ws)['local_count'], 3)
        self.assertEqual(read_request(self.ws)['sources']['refs'], self.refs)

    def test_provided_only_all_pending_plan_command_waits_without_plan(self):
        configure(self.ws, {'sources': {'policy': 'provided_only', 'refs': self.refs}})
        response = self.response(self.manifest(ready=0))
        path = self.root / 'activation.json'
        path.write_text(json.dumps(response))
        args = SimpleNamespace(action='plan-packet', plan_action=None, patch=None,
                               workspace=str(self.ws), request=str(path), full=True)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(slr.cmd_writing(args), 0)
        self.assertEqual(json.loads(output.getvalue())['status'], 'WAITING_MATERIALS')
        self.assertFalse((self.ws / '01_input/plan_packet.json').exists())

    def test_init_snapshots_local_pdf_and_returns_bound_activation(self):
        source = self.root / 'source.pdf'
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((50, 90), 'An original paper source for local material preparation.')
        document.save(source)
        document.close()
        request = {'intent': 'Compare only the supplied method and its limitations.',
                   'execution': {'mode': 'standard'}, 'outline_review': 'required',
                   'language': 'zh', 'deliverable': {'kind': 'fragment', 'unit': 'paragraph'},
                   'local_pdfs': [{'path': 'source.pdf', 'title': 'Actual source',
                                   'authors': ['Actual Author'], 'year': 2024}]}
        path = self.root / 'initial.json'
        path.write_text(json.dumps(request))
        target = self.root / 'local-task'
        args = SimpleNamespace(workspace=str(target), intent=None, request=str(path),
                               language='auto', mode='standard', full=False)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(slr.cmd_init(args), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result['activation_request']['workspace'], 'local-task')
        self.assertTrue((target / '.slr-binding.json').is_file())
        self.assertTrue((target / '02_retrieval/local_papers.json').is_file())
        self.assertEqual(read_request(target)['intent'], request['intent'])
        self.assertEqual(read_request(target)['outline_review'], 'required')
        self.assertEqual(read_request(target)['output_scope'], 'section')
        self.assertEqual(read_request(target)['language'], 'CHINESE')
        self.assertEqual(read_request(target)['local_pdfs'][0]['path'], str(source))
        self.assertNotIn('created', result)

    def test_new_init_rejects_unactivatable_external_workspace_before_writes(self):
        with tempfile.TemporaryDirectory() as other:
            target = Path(other) / 'external-task'
            args = SimpleNamespace(workspace=str(target), intent='Compare these sources.', request=None,
                                   language='auto', mode='quick', full=False)
            with self.assertRaisesRegex(ValueError, 'session working directory'):
                slr.cmd_init(args)
            self.assertFalse(target.exists())

    def test_missing_relative_local_input_fails_before_task_creation(self):
        target = self.root / 'missing-input-task'
        request = self.root / 'missing.json'
        request.write_text(json.dumps({'intent': 'Analyze the supplied paper.',
            'execution': {'mode': 'standard'}, 'local_pdfs': ['absent.pdf']}))
        args = SimpleNamespace(workspace=str(target), intent=None, request=str(request),
                               language='auto', mode='standard', full=False)
        with self.assertRaisesRegex(ValueError, 'session working directory'):
            slr.cmd_init(args)
        self.assertFalse(target.exists())

    def entry(self, ref, state='ready', **values):
        identity = ref.removeprefix('literature:')
        metadata = {'title': 'Study ' + identity, 'authors': ['Ada Author'], 'year': 2024,
                    'abstract': 'Original abstract for study ' + identity + '.',
                    'doi': '', 'arxiv_id': '', 'external_ids': {}, **values}
        detail = {'ok': True, 'scope': 'current_project', 'notice': 'Bibliography only.',
                  'item': {'id': identity, 'title': metadata['title'], 'authors': 'Ada Author',
                           'year': 2024, 'publication': '', 'doi': '', 'version': 1},
                  'abstract': metadata['abstract'], 'attachments': [], 'source_url': '/literature/' + identity}
        return {'ref_id': ref, 'state': state, 'metadata': metadata, 'detail': detail,
                'source_version': 1, 'issues': ['abstract'] if state == 'pending' else []}

    def manifest(self, ready=3):
        selection = {'refs': self.refs, 'project_id': 'project', 'revision': 1,
                     'source_versions': {ref: 1 for ref in self.refs}}
        return {'schema': 'selected-sources/v2', 'run_id': self.run_id, 'workspace': 'survey',
                'selection': selection, 'selection_sha256': digest(selection), 'job_id': 'prepared',
                'state': 'partial', 'ready': self.refs[:ready], 'pending': self.refs[ready:], 'duplicates': {},
                'entries': [self.entry(ref, 'ready' if index < ready else 'pending',
                           **({} if index < ready else {'abstract': ''})) for index, ref in enumerate(self.refs)]}

    def response(self, manifest):
        payload = json.dumps(manifest).encode()
        path = self.ws / '02_retrieval/_selected' / (hashlib.sha256(payload).hexdigest() + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return {'ok': True, 'workspace': 'survey', 'run_id': self.run_id,
                'selected_sources': {'schema': manifest['schema'], 'path': path.relative_to(self.root).as_posix(),
                                     'sha256': hashlib.sha256(payload).hexdigest()}}

    def test_mixed_preparation_keeps_refs_and_budgets_ready_unique_count(self):
        response = self.response(self.manifest())
        result = import_materials(self.ws, response)
        self.assertEqual(result['status'], 'SUCCESS')
        self.assertEqual(result['pending_count'], 2)
        self.assertEqual(len(load_local(self.ws)), 3)
        self.assertEqual(budget(self.ws)['search_target'], 3)
        self.assertEqual(read_request(self.ws)['sources']['refs'], self.refs)
        before = (self.ws / '02_retrieval/material_papers.json').read_bytes()
        import_materials(self.ws, response)
        self.assertEqual((self.ws / '02_retrieval/material_papers.json').read_bytes(), before)

    def test_preparation_rejects_non_protocol_paths(self):
        for reference in ('', '.', '/outside.json', '../outside.json',
                          'survey/../outside.json', 'C:/outside.json',
                          'C:outside.json', '//server/share/source.json',
                          'survey\\source.json'):
            with self.subTest(reference=reference):
                response = self.response(self.manifest())
                response['selected_sources']['path'] = reference
                with self.assertRaisesRegex(ValueError, 'session-relative'):
                    import_materials(self.ws, response)

    def test_preparation_checks_protocol_before_native_path_conversion(self):
        response = self.response(self.manifest())
        reference = response['selected_sources']['path']
        with patch('prepared.Path', wraps=Path) as native_path:
            native_path.side_effect = lambda value: PureWindowsPath(value) if value == reference else Path(value)
            result = import_materials(self.ws, response)
        self.assertEqual(result['status'], 'SUCCESS')

    def test_collection_keeps_original_ref_and_all_24_ready_members(self):
        self.refs = ['literature:' + str(index) for index in range(24)]
        manifest = self.manifest(24)
        collection = 'literature_collection:actual-collection'
        refs = [collection, self.refs[0]]
        manifest['schema'] = 'selected-sources/v3'
        manifest['selection'].update(refs=refs, collections={collection: self.refs}, expanded_refs=self.refs)
        manifest['selection_sha256'] = digest(manifest['selection'])
        configure(self.ws, {'sources': {'policy': 'provided_only', 'refs': refs}})
        result = import_materials(self.ws, self.response(manifest))
        self.assertEqual(result['unique_papers'], 24)
        self.assertEqual(len(load_local(self.ws)), 24)
        self.assertEqual(budget(self.ws)['search_target'], 0)
        self.assertEqual(read_request(self.ws)['sources']['refs'], refs)
        manifest['selection']['collections'][collection] = self.refs[:-1]
        manifest['selection_sha256'] = digest(manifest['selection'])
        with self.assertRaisesRegex(ValueError, 'expanded selection'):
            import_materials(self.ws, self.response(manifest))

    def test_all_pending_provided_only_waits_without_search_or_pdf(self):
        configure(self.ws, {'sources': {'policy': 'provided_only', 'refs': self.refs}})
        result = import_materials(self.ws, self.response(self.manifest(0)))
        self.assertEqual(result['status'], 'WAITING_MATERIALS')
        self.assertEqual(load_local(self.ws), {})
        self.assertEqual(budget(self.ws)['search_target'], 0)
        self.assertEqual(budget(self.ws)['state'], 'waiting_materials')
        self.assertEqual(read_request(self.ws)['sources']['refs'], self.refs)

    def test_all_pending_supplement_uses_full_target(self):
        import_materials(self.ws, self.response(self.manifest(0)))
        self.assertEqual(budget(self.ws)['search_target'], 6)

    def test_duplicate_maps_to_one_ready_paper_without_losing_refs(self):
        manifest = self.manifest(2)
        duplicate = self.entry(self.refs[1], 'duplicate', **manifest['entries'][0]['metadata'])
        manifest['entries'][1] = duplicate
        manifest['ready'] = self.refs[:1]
        manifest['duplicates'] = {self.refs[1]: self.refs[0]}
        result = import_materials(self.ws, self.response(manifest))
        self.assertEqual(result['unique_papers'], 1)
        self.assertEqual(result['duplicate_count'], 1)
        self.assertEqual(next(iter(load_local(self.ws).values()))['library_refs'], self.refs[:2])
        self.assertEqual(budget(self.ws)['search_target'], 5)

    def test_different_arxiv_versions_cannot_be_hidden_as_duplicates(self):
        manifest = self.manifest(2)
        manifest['entries'][0]['metadata']['arxiv_id'] = '1706.03762v1'
        manifest['entries'][1] = self.entry(self.refs[1], 'duplicate', **{
            **manifest['entries'][0]['metadata'], 'arxiv_id': '1706.03762v7'})
        manifest['ready'] = self.refs[:1]
        manifest['duplicates'] = {self.refs[1]: self.refs[0]}
        with self.assertRaisesRegex(ValueError, 'different source or version'):
            import_materials(self.ws, self.response(manifest))

    def test_manifest_must_explain_every_original_reference(self):
        manifest = self.manifest()
        manifest['pending'].pop()
        with self.assertRaisesRegex(ValueError, 'partition'):
            import_materials(self.ws, self.response(manifest))

    def test_changed_manifest_or_activation_binding_is_rejected(self):
        response = self.response(self.manifest())
        source = self.root / response['selected_sources']['path']
        source.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            import_materials(self.ws, response)
        response = self.response(self.manifest())
        response['run_id'] = 'another-task'
        with self.assertRaisesRegex(ValueError, 'binding mismatch'):
            import_materials(self.ws, response)

    def test_pre_freeze_refresh_incorporates_a_completed_pending_record(self):
        import_materials(self.ws, self.response(self.manifest()))
        before = resume_guard(self.ws, 'retrieval_adapt')
        atomic_json(self.ws / '02_retrieval/metadata.json', {'papers': []})
        atomic_json(self.ws / '02_retrieval/selected_paper.json', {})
        atomic_json(self.ws / '02_retrieval/retrieval_report.json', {'status': 'FAILED'})
        import_materials(self.ws, self.response(self.manifest(4)))
        self.assertNotEqual(resume_guard(self.ws, 'retrieval_adapt'), before)
        self.assertEqual(len(load_local(self.ws)), 4)
        self.assertEqual(budget(self.ws)['search_target'], 2)

    def test_post_freeze_refresh_preserves_original_materials_and_draft(self):
        import_materials(self.ws, self.response(self.manifest()))
        material = self.ws / '02_retrieval/material_papers.json'
        before = material.read_bytes()
        atomic_json(self.ws / '02_retrieval/selected_paper.json', load_local(self.ws))
        draft = self.ws / '05_generation/draft.md'
        draft.parent.mkdir(parents=True)
        draft.write_text('Completed scientific draft.')
        with self.assertRaisesRegex(ValueError, 'frozen'):
            import_materials(self.ws, self.response(self.manifest(4)))
        self.assertEqual(material.read_bytes(), before)
        self.assertEqual(draft.read_text(), 'Completed scientific draft.')

    def test_snapshot_loading_does_not_depend_on_process_cwd(self):
        import_materials(self.ws, self.response(self.manifest()))
        os.chdir(ROOT)
        self.assertEqual(len(load_local(self.ws)), 3)


if __name__ == '__main__':
    unittest.main()
