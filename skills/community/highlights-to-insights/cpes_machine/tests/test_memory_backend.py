"""Memory execution consumes real Codex JSONL shapes without writing model output."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cpes.backends import CodexBackend
from cpes.contracts import CpesError
from cpes.figures import load_skill


def events(text='{"overview":"final card"}'):
    return '\n'.join(json.dumps(value) for value in [
        {'type': 'thread.started', 'thread_id': 'thread-test'},
        {'type': 'turn.started'},
        {'type': 'item.completed', 'item': {'id': 'item_0', 'type': 'reasoning', 'text': 'Private intermediate text'}},
        {'type': 'item.completed', 'item': {'id': 'item_1', 'type': 'agent_message', 'text': text}},
        {'type': 'turn.completed', 'usage': {'input_tokens': 17, 'cached_input_tokens': 5, 'output_tokens': 9}},
    ])


class MemoryBackendTests(unittest.TestCase):
    def test_jsonl_final_message_and_usage_stay_in_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / 'must-not-exist'
            schema_paths = []
            written = []
            original_write = Path.write_text
            def record_write(path, *args, **kwargs):
                written.append(path.name)
                return original_write(path, *args, **kwargs)
            def execute(command, **kwargs):
                self.assertNotIn('--output-last-message', command)
                self.assertNotIn('--ignore-user-config', command)
                self.assertNotIn('--model', command)
                self.assertEqual(command[command.index('--image') + 1], '/sample.png')
                self.assertIn('Do not call tools or read additional files.', kwargs['input'])
                schema_path = Path(command[command.index('--output-schema') + 1])
                schema_paths.append(schema_path)
                self.assertEqual(json.loads(schema_path.read_text()), {'type': 'object'})
                self.assertEqual(list(schema_path.parent.iterdir()), [schema_path])
                self.assertFalse(work.exists())
                return types.SimpleNamespace(returncode=0, stdout=events(), stderr='transient diagnostics')
            with patch('cpes.backends.subprocess.run', execute), patch.object(Path, 'write_text', record_write):
                result = CodexBackend(debug=False).generate('reader policy', {'type': 'object'}, ['/sample.png'], work)
            self.assertEqual(json.loads(result['output_text']), {'overview': 'final card'})
            self.assertEqual(result['usage'], {'usage_events': [{'input_tokens': 17, 'cached_input_tokens': 5, 'output_tokens': 9}], 'exit_code': 0})
            self.assertFalse(work.exists())
            self.assertTrue(all(not path.exists() for path in schema_paths))
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertEqual(written, ['schema.json'])

    def test_failed_and_invalid_jsonl_outputs_are_rejected_without_files(self):
        cases = [
            (1, events(), 'codex_failed'),
            (0, events('not JSON'), 'invalid_model_json'),
            (0, '{invalid JSONL}', 'invalid_model_json'),
            (0, json.dumps({'type': 'turn.completed', 'usage': {}}), 'missing_model_output'),
            (0, events().rsplit('\n', 1)[0], 'codex_failed'),
            (0, events() + '\n' + json.dumps({'type': 'turn.failed', 'error': {'message': 'failed'}}), 'codex_failed'),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for code, stdout, expected in cases:
                with self.subTest(expected=expected, stdout=stdout):
                    response = types.SimpleNamespace(returncode=code, stdout=stdout, stderr='diagnostics')
                    with patch('cpes.backends.subprocess.run', return_value=response), self.assertRaises(CpesError) as caught:
                        CodexBackend(debug=False).generate('policy', {'type': 'object'}, [], Path(tmp) / 'worker')
                    self.assertEqual(caught.exception.code, expected)
                    self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_intent_uses_same_memory_transport(self):
        intent = dict(action='extract_figures', figure_numbers=['1'], all_figures=False,
                      include_appendix=False, include_image=True, include_caption=True, question='', reason='')
        response = types.SimpleNamespace(returncode=0, stdout=events(json.dumps(intent)), stderr='')
        with tempfile.TemporaryDirectory() as tmp, patch('cpes.backends.subprocess.run', return_value=response):
            self.assertEqual(CodexBackend(debug=False).decide('Figure 1', Path(tmp) / 'worker'), intent)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_transport_errors_clean_up_schema_and_do_not_write_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            for error, expected in [(FileNotFoundError(), 'codex_unavailable'),
                                    (subprocess.TimeoutExpired('codex', 1), 'model_timeout')]:
                schema_paths = []
                def execute(command, **kwargs):
                    schema_paths.append(Path(command[command.index('--output-schema') + 1]))
                    raise error
                with self.subTest(expected=expected), patch('cpes.backends.subprocess.run', execute), self.assertRaises(CpesError) as caught:
                    CodexBackend(debug=False).generate('policy', {'type': 'object'}, [], Path(tmp) / 'worker')
                self.assertEqual(caught.exception.code, expected)
                self.assertTrue(all(not path.exists() for path in schema_paths))
                self.assertEqual(list(Path(tmp).iterdir()), [])


class MemoryJobTests(unittest.TestCase):
    def setUp(self):
        self.skill = load_skill()
        self.job = {'image_files': ['/not-read-by-runner.png'], 'card_template': {
            'schema_version': 7, 'paper_id': 'paper', 'figure_id': 'figure-1', 'label': None,
            'caption': {'number': '1', 'text': 'Caption.', 'display': 'Caption.', 'number_source': 'pdf-caption', 'number_uncertain': False},
            'source': {'tex_file': 'source.txt', 'line_start': 1, 'line_end': 1, 'image_paths': ['figure.png']},
            'visual_status': 'inspected',
            **{key: '' if key == 'overview' else [] for key in self.skill.MUTABLE_FIELDS}},
            'context': {'figure_source': [{'line': 1, 'text': 'Caption.'}]}}
        self.raw = dict(overview='A complete card.', panels=[{'panel_id': 'main', 'title': '', 'visual_observations': ['An axis.']}],
                        how_to_read=['Read the axis.'], author_findings=[{'claim': 'Caption.', 'evidence_ids': ['L1']}],
                        prerequisites=[], scope=[])

    def run_memory(self, callback, maximum=1):
        self.assertTrue(hasattr(self.skill, 'run_job_memory'), 'The memory-only job API must be available')
        budget = self.skill.CallBudget(maximum)
        with patch.object(Path, 'open', side_effect=AssertionError('Memory runner must not open files')), \
             patch.object(Path, 'mkdir', side_effect=AssertionError('Memory runner must not create directories')):
            value = self.skill.run_job_memory(None, 'test-model', self.job, budget, invoke_model=callback)
        return value, budget.used

    def test_completed_card_binds_evidence_without_io(self):
        (record, raw, card), used = self.run_memory(lambda *args: (self.raw, {'response': 'private'}, {'input_tokens': 3}, None))
        self.assertEqual((record['status'], record['attempt_count'], used), ('completed', 1, 1))
        self.assertEqual(raw, self.raw)
        self.assertEqual(card['overview'], 'A complete card.')
        self.assertEqual(card['author_findings'][0]['evidence'], [{'file': 'source.txt', 'line_start': 1, 'line_end': 1, 'kind': 'caption'}])
        self.assertEqual(set(record), {'status', 'model', 'wall_ms', 'usage', 'attempt_count', 'error'})

    def test_quality_failure_never_delivers_a_card(self):
        for raw, error in [(self.raw, 'Invalid schema'), ({**self.raw, 'overview': ''}, None)]:
            with self.subTest(error=error):
                (record, returned, card), used = self.run_memory(lambda *args: (raw, {}, None, error))
                self.assertEqual((record['status'], used), ('quality_failure', 1))
                self.assertEqual(returned, raw)
                self.assertIsNone(card)

    def test_execution_failure_is_not_retried(self):
        def fail(*args): raise TimeoutError('connection timeout')
        (record, raw, card), used = self.run_memory(fail, maximum=2)
        self.assertEqual((record['status'], record['attempt_count'], used), ('execution_error', 1, 1))
        self.assertIsNone(raw)
        self.assertIsNone(card)

    def test_exhausted_budget_does_not_invoke_model(self):
        def fail(*args): raise AssertionError('No model allowed')
        (record, raw, card), used = self.run_memory(fail, maximum=0)
        self.assertEqual((record['status'], record['attempt_count'], used), ('execution_error', 0, 0))
        self.assertIsNone(card)

    def test_missing_images_do_not_consume_budget_or_invoke_model(self):
        self.job['image_files'] = []
        def fail(*args): raise AssertionError('No model allowed')
        (record, raw, card), used = self.run_memory(fail)
        self.assertEqual((record['status'], record['attempt_count'], used), ('media_unavailable', 0, 0))
        self.assertIsNone(card)

    def test_typed_provider_failure_keeps_safe_status_without_response_details(self):
        self.assertTrue(hasattr(self.skill, 'ModelExecutionError'))
        def fail(*args): raise self.skill.ModelExecutionError('RateLimitError', 429)
        (record, raw, card), used = self.run_memory(fail)
        self.assertEqual(record['status'], 'execution_error')
        self.assertEqual(record['error'], 'RateLimitError; HTTP status 429')
        self.assertEqual(record['http_status'], 429)
        self.assertEqual(used, 1)
        self.assertIsNone(card)

    def test_codex_failure_keeps_error_code_but_never_arbitrary_exception_message(self):
        for exc, code in [(CpesError('model_timeout', 'secret-token-123'), 'model_timeout'),
                          (RuntimeError('secret-token-123; HTTP status 429'), None),
                          (CpesError('secret-token-123', 'secret-token-123'), None)]:
            def fail(*args): raise exc
            (record, _, card), _ = self.run_memory(fail)
            self.assertNotIn('secret-token-123', json.dumps(record))
            self.assertEqual(record.get('error_code'), code)
            self.assertNotIn('http_status', record)
            self.assertIsNone(card)

    def test_typed_failure_drops_metadata_outside_bounded_allowlist(self):
        self.assertTrue(hasattr(self.skill, 'ModelExecutionError'))
        def fail(*args):
            raise self.skill.ModelExecutionError('SECRET response header: bearer-token', 'secret-token-123', 'x' * 65)
        (record, _, card), _ = self.run_memory(fail)
        self.assertEqual(record['error'], 'ModelExecutionError')
        self.assertNotIn('http_status', record)
        self.assertNotIn('error_code', record)
        self.assertNotIn('secret-token-123', json.dumps(record))


if __name__ == '__main__': unittest.main()
