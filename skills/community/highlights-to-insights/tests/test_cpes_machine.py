"""Offline tests for the vendored runtime and HINT's isolated writer bridge."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from pdf_fixture import simple_pdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))


class MachineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hint-machine-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        pdf = self.root / 'paper.pdf'
        simple_pdf(pdf, 'Forecasts require uncertainty estimates.', annotations=True)
        from reading_pipeline import prepare
        prepare(pdf, self.root / 'reading')
        self.index = self.root / 'reading/reading.json'

    def request(self, images=()):
        from cpes_machine.writer import prepare_request
        path = self.root / 'request.json'
        prepare_request(self.index, path, images=images)
        return path

    def draft(self):
        index = json.loads(self.index.read_text())
        ids = [s['id'] for s in index['catalog']]
        return {'title': 'Uncertainty in forecasting', 'sections': [{'title': 'Mechanism', 'paragraphs': [
            {'text': 'The method represents forecast uncertainty.', 'source_ids': ids,
             'identity': 'mixed'}]}], 'omissions': []}

    def events(self, draft=None, failed=False):
        events = [{'type': 'turn.started'}, {'type': 'item.completed', 'item': {
            'type': 'agent_message', 'text': json.dumps(self.draft() if draft is None else draft)}},
            {'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 60, 'output_tokens': 30}}]
        if failed:
            events.append({'type': 'turn.failed', 'error': {'message': 'failed'}})
        return '\n'.join(json.dumps(e) for e in events)

    def test_hints_native_index_uses_vendored_line_geometry(self):
        index = json.loads(self.index.read_text())
        self.assertEqual(index['lines'][0]['font_size'], 11)
        self.assertEqual(index['lines'][0]['source_line_id'], 'p0001-b0000-l0000')
        self.assertIn('cpes_machine/cpes-format-converter/cpes_format_converter/native.py', index['code_hashes'])

    def test_runtime_and_native_reader_relocate_without_original_checkout(self):
        moved = self.root / 'moved'
        shutil.copytree(ROOT / 'cpes_machine', moved / 'cpes_machine', ignore=shutil.ignore_patterns('__pycache__'))
        result = subprocess.run([sys.executable, '-I', '-c',
            'import sys; sys.path.insert(0, sys.argv[1]); import cpes_machine; '
            'from cpes_machine import native_lines; from cpes.entry import describe; '
            'from cpes.tables import load_skill; assert load_skill().output_schema(); '
            'print(describe()["entry_version"])', str(moved)], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'V36')
        self.assertNotIn('/0917_cpes/', result.stderr)

    def test_request_includes_the_guide_once_and_preserves_materials_without_a_model_call(self):
        from cpes_machine.writer import load_request
        with patch('subprocess.run', side_effect=AssertionError('No model allowed')):
            path = self.request()
        request = load_request(path)
        guide = (ROOT / 'references/writing-guide.md').read_text()
        packet = (self.index.parent / 'packet.md').read_text()
        self.assertIn(guide.rstrip(), request['prompt'])
        self.assertEqual(request['prompt'].count(guide.rstrip()), 1)
        self.assertTrue(request['prompt'].endswith(packet))
        self.assertEqual(request['images'], [])
        self.assertNotIn('source_refs', request['prompt'])
        self.assertNotIn('enum', request['schema']['properties']['sections']['items']['properties']['paragraphs']['items']['properties']['source_ids']['items'])
        self.assertIsNone(request['model'])
        self.assertIn('src/cpes/figures.py', request['code_hashes'])

    def test_prepared_packet_contains_materials_without_a_writing_recipe(self):
        packet = (self.index.parent / 'packet.md').read_text()
        headings = [line for line in packet.splitlines() if line.startswith('# ')]
        self.assertEqual(headings, ['# 论文与材料状态', '# 阅读标记', '# 原文证据'])
        self.assertIn('Forecasts require uncertainty estimates.', packet)
        self.assertIn('How is uncertainty represented?', packet)

    def test_guide_change_invalidates_an_already_prepared_request(self):
        from cpes_machine import writer
        moved = self.root / 'skill'
        shutil.copytree(ROOT, moved, ignore=shutil.ignore_patterns('__pycache__'))
        guide = moved / 'references/writing-guide.md'
        with patch.object(writer, 'ROOT', moved / 'cpes_machine'):
            path = self.request()
            writer.load_request(path)
            guide.write_text(guide.read_text() + '\nExplain concepts using familiar language.\n')
            with self.assertRaisesRegex(ValueError, 'Writer code changed'):
                writer.load_request(path)

    def test_missing_guide_stops_request_preparation(self):
        from cpes_machine import writer
        moved = self.root / 'skill'
        shutil.copytree(ROOT, moved, ignore=shutil.ignore_patterns('__pycache__'))
        (moved / 'references/writing-guide.md').unlink()
        with patch.object(writer, 'ROOT', moved / 'cpes_machine'):
            with self.assertRaises(FileNotFoundError):
                self.request()
        self.assertFalse((self.root / 'request.json').exists())

    def test_resolved_language_is_forwarded_without_changing_packet_or_evidence(self):
        from cpes_machine.writer import prepare_request, load_request
        packet = (self.index.parent / 'packet.md').read_bytes()
        path = self.root / 'english-request.json'
        with patch('subprocess.run', side_effect=AssertionError('No model allowed')):
            prepare_request(self.index, path, language=' English ')
        request = load_request(path)
        self.assertEqual(request['language'], 'English')
        self.assertTrue(request['prompt'].startswith('Output language: "English".'))
        self.assertTrue(request['prompt'].endswith(packet.decode()))
        self.assertEqual((self.index.parent / 'packet.md').read_bytes(), packet)
        request['language'] = 'Chinese'
        path.write_text(json.dumps(request))
        with self.assertRaisesRegex(ValueError, 'Writing request changed'):
            load_request(path)

    def test_empty_language_is_rejected_before_creating_request(self):
        from cpes_machine.writer import prepare_request
        path = self.root / 'empty-language.json'
        with self.assertRaises(ValueError):
            prepare_request(self.index, path, language='   ')
        self.assertFalse(path.exists())

    def test_untitled_opening_preserves_paragraph_mapping(self):
        import hashlib
        from reading_pipeline import assemble
        draft = self.draft()
        draft['sections'][0]['title'] = ''
        later = copy.deepcopy(draft['sections'][0])
        later['title'] = 'Mechanism'
        later['paragraphs'][0]['text'] = 'The ensemble expresses uncertainty.'
        draft['sections'].append(later)
        path = self.root / 'draft.json'
        path.write_text(json.dumps(draft))
        assemble(self.index, path, self.root / 'final')
        note = (self.root / 'final/note.md').read_text()
        self.assertTrue(note.startswith('#### Uncertainty in forecasting\n\nThe method represents forecast uncertainty.\n\n##### Mechanism\n'))
        self.assertNotIn('<!-- hint:paragraph_id=', note)
        mapping = json.loads((self.root / 'final/source-map.json').read_text())
        self.assertEqual(len(mapping['paragraphs']), 2)
        for record, section in zip(mapping['paragraphs'], draft['sections']):
            self.assertEqual(record['source_ids'], section['paragraphs'][0]['source_ids'])
            bounds = record['markdown_lines']
            text = '\n'.join(note.splitlines()[bounds['start']-1:bounds['end']])
            self.assertEqual(text, section['paragraphs'][0]['text'])
            self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), record['text_sha256'])
        draft['sections'][1]['title'] = ''
        path.write_text(json.dumps(draft))
        with self.assertRaises(ValueError):
            assemble(self.index, path, self.root / 'invalid')
        self.assertFalse((self.root / 'invalid/note.md').exists())

    def test_writer_uses_isolated_backend_and_reuses_completed_receipt(self):
        from cpes_machine.writer import execute
        path = self.request()
        def run(command, **kwargs):
            self.assertIn('--ephemeral', command)
            cwd = Path(command[command.index('--cd') + 1])
            self.assertNotEqual(cwd, ROOT)
            self.assertEqual([p.name for p in cwd.iterdir()], ['schema.json'])
            self.assertNotIn('--model', command)
            self.assertIn('Do not call tools or read additional files.', kwargs['input'])
            return types.SimpleNamespace(returncode=0, stdout=self.events(), stderr='')
        with patch('cpes.backends.subprocess.run', side_effect=run) as model:
            result = execute(path, self.root / 'result')
            second = execute(path, self.root / 'result')
        self.assertEqual(model.call_count, 1)
        self.assertEqual(result['usage']['input_tokens'], 100)
        self.assertEqual(result['usage']['uncached_input_tokens'], 40)
        self.assertEqual(second['new_model_calls'], 0)
        self.assertTrue(second['reused'])
        self.assertIsNone(result['usage']['image_tokens'])
        self.assertEqual({p.name for p in (self.root / 'result').iterdir()}, {'receipt.json', 'response.json', 'draft.json'})

    def test_failed_receipt_keeps_usage_and_cannot_be_automatically_retried(self):
        from cpes_machine.writer import execute
        path = self.request()
        with patch('cpes.backends.subprocess.run', return_value=types.SimpleNamespace(returncode=0, stdout=self.events(failed=True), stderr='')) as model:
            with self.assertRaises(Exception):
                execute(path, self.root / 'result')
            with self.assertRaises(ValueError):
                execute(path, self.root / 'result')
        self.assertEqual(model.call_count, 1)
        receipt = json.loads((self.root / 'result/receipt.json').read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['usage']['input_tokens'], 100)

    def test_changed_selected_image_is_rejected_before_dispatch(self):
        from cpes_machine.writer import execute
        image = self.root / 'detail.png'
        image.write_bytes(b'initial image')
        path = self.request([image])
        image.write_bytes(b'changed image')
        with patch('cpes.backends.subprocess.run', side_effect=AssertionError('No model allowed')):
            with self.assertRaisesRegex(ValueError, 'changed'):
                execute(path, self.root / 'result')
        self.assertFalse((self.root / 'result').exists())

    def test_unknown_source_response_is_preserved_but_not_accepted(self):
        from cpes_machine.writer import execute
        draft = self.draft()
        draft['sections'][0]['paragraphs'][0]['source_ids'] = ['invented']
        path = self.request()
        with patch('cpes.backends.subprocess.run', return_value=types.SimpleNamespace(returncode=0, stdout=self.events(draft), stderr='')):
            with self.assertRaisesRegex(ValueError, 'Unknown source'):
                execute(path, self.root / 'result')
        self.assertTrue((self.root / 'result/response.json').exists())
        self.assertFalse((self.root / 'result/draft.json').exists())

    def test_external_response_can_be_accepted_without_model_calls(self):
        from cpes_machine.writer import accept
        path = self.request()
        response = self.root / 'external.json'
        response.write_text(json.dumps({'output_text': json.dumps(self.draft()), 'usage': {'input_tokens': 80, 'output_tokens': 20}}))
        with patch('cpes.backends.subprocess.run', side_effect=AssertionError('No model allowed')):
            result = accept(path, response, self.root / 'result')
        self.assertEqual(result['new_model_calls'], 0)
        self.assertEqual(result['usage']['input_tokens'], 80)

    def test_changed_completed_draft_is_not_reused(self):
        from cpes_machine.writer import execute
        path = self.request()
        with patch('cpes.backends.subprocess.run', return_value=types.SimpleNamespace(returncode=0, stdout=self.events(), stderr='')):
            execute(path, self.root / 'result')
        (self.root / 'result/draft.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'changed'):
            execute(path, self.root / 'result')

    def test_incomplete_completed_receipt_cannot_bypass_file_verification(self):
        from cpes_machine.writer import execute
        path = self.request()
        with patch('cpes.backends.subprocess.run', return_value=types.SimpleNamespace(returncode=0, stdout=self.events(), stderr='')):
            execute(path, self.root / 'result')
        receipt_path = self.root / 'result/receipt.json'
        receipt = json.loads(receipt_path.read_text())
        receipt['files'] = {}
        receipt_path.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, 'receipt'):
            execute(path, self.root / 'result')


class InterpreterTests(unittest.TestCase):
    def test_figure_preparation_and_finalization_use_active_interpreter_and_preserve_failure(self):
        path = ROOT / 'cpes_machine/cpes-figure/scripts/generate_cards.py'
        spec = importlib.util.spec_from_file_location('figure_interpreter_contract', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for final_code in (0, 7):
            with self.subTest(final_code=final_code), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                paper = root / 'paper.tex'
                paper.write_text('', encoding='utf-8')
                output = root / 'output'
                arguments = [str(path), '--paper', str(paper), '--output', str(output), '--max-calls', '0']
                with (
                    patch.object(sys, 'argv', arguments),
                    patch.dict(os.environ, {'FIGCARD_QWEN_API_KEY': 'unused-unit-test',
                                            'FIGCARD_QWEN_BASE_URL': 'https://unused.invalid'}, clear=True),
                    patch.object(module, 'build_client', return_value=None),
                    patch.object(module, 'run_job', side_effect=AssertionError('no model jobs permitted')),
                    patch.object(module.subprocess, 'run', side_effect=[
                        types.SimpleNamespace(returncode=0), types.SimpleNamespace(returncode=final_code),
                    ]) as run,
                    patch('builtins.print'),
                ):
                    result = module.main()
                self.assertEqual(result, 0 if final_code == 0 else 1)
                self.assertEqual(run.call_count, 2)
                prepare, finalize = run.call_args_list
                self.assertEqual(prepare.args[0], [sys.executable, str(module.BATCH_RUNNER), 'prepare',
                                                 '--paper', str(paper.resolve()), '--output', str(output.resolve())])
                self.assertTrue(prepare.kwargs['check'])
                self.assertEqual(finalize.args[0], [sys.executable, str(module.BATCH_RUNNER), 'finalize',
                                                  '--output', str(output.resolve())])


if __name__ == '__main__':
    unittest.main()
