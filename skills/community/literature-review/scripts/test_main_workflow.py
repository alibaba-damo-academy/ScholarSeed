"""Offline checks for presentation equivalence and decision-boundary execution."""
import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'lib')]
import slr
from main_view import compact
from task_contract import atomic_json, configure
from task_fixtures import task
from workflow import advance, execute


class MainViewTest(unittest.TestCase):
    def test_real_publication_workflow_keeps_rules_and_returns_deliverable(self):
        import shutil
        from test_native_pipeline import NativeTest as PipelineTest, Model as Author
        formats = ['markdown']
        if shutil.which('pdflatex') and shutil.which('bibtex'):
            formats.append('latex_pdf')
        for fmt in formats:
            with self.subTest(format=fmt):
                fixture = PipelineTest()
                fixture.setUp()
                try:
                    configure(fixture.ws, {'publication': {'format': fmt}})
                    author = Author()
                    fixture.run_pipeline(author)
                    calls = len(author.calls)
                    result = advance(fixture.ws, 'publish')
                    self.assertEqual(result['status'], 'SUCCESS', result)
                    self.assertEqual(result['boundary'], 'delivery' if fmt == 'markdown' else 'pdf_inspection')
                    self.assertTrue(Path(result['deliverable']).is_file())
                    self.assertIn('unknown_citations',[c['id'] for c in result['result']['checks']])
                    self.assertFalse(result['result']['visual_review_complete'])
                    self.assertEqual(len(author.calls), calls)
                    if fmt == 'latex_pdf':
                        self.assertTrue(result['result']['pages_to_read'])
                        self.assertLessEqual(len(result['result']['pages_to_read']), 3)
                        self.assertTrue(all(Path(p).is_file() for p in result['result']['pages_to_read']))
                finally:
                    fixture.doCleanups()

    def test_projection_preserves_decisions_without_mutating_full_record(self):
        value = {'status': 'FAILED', 'code': 'RULES', 'outline': {'large': 'plan'},
                 'outline_markdown': '- 1 Methods\n  - F1 Geometry', 'packet_id': 'abc',
                 'options': {'formats': ['markdown']}, 'summary_inputs': {'constraints': ['keep']},
                 'checks': [{'id': 'unknown_citations', 'status': 'FAILED', 'unknown': ['X']}],
                 'pages_to_read': ['page.png'], 'render_error': None,
                 'steps': [{'status': 'FAILED', 'detail': {'large': 'payload'}}]}
        before = copy.deepcopy(value)
        projected = compact(value)
        self.assertEqual(value, before)
        self.assertNotIn('outline', projected)
        self.assertNotIn('detail', projected['steps'][0])
        for key in ('status', 'code', 'outline_markdown', 'packet_id', 'options',
                    'summary_inputs', 'checks', 'pages_to_read', 'render_error'):
            self.assertEqual(value[key], projected[key])

    def test_nested_check_cannot_hide_outer_failure(self):
        value = {'status': 'FAILED', 'checks': [{'status': 'SUCCESS'}]}
        text = 'log\n' + json.dumps({'status': 'RUNNING'}) + '\n' + json.dumps(value) + '\ntrailer'
        self.assertEqual(slr.extract_trailing_json(text), value)

    def test_review_packet_default_and_full_preserve_disk_plan(self):
        from operator_cli import review_packet
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            configure(ws, task({'publication': {'format': 'markdown'}}))
            outline = {'survey_title': 'Test', 'topic': 'Test', 'outline_tree': [
                {'section_id': '1', 'title': 'Methods', 'description': 'Compare actual mechanisms.'}]}
            from task_fixtures import planned_outline
            atomic_json(ws / '04_outline/outline.json', planned_outline(outline))
            options = {'formats': ['markdown'], 'templates': [], 'citation_styles': []}
            with patch('operator_cli.publication_options', return_value=options):
                full = review_packet(ws)
                for flag in (False, True):
                    stream = io.StringIO()
                    args = SimpleNamespace(workspace=str(ws), action='review-packet', full=flag)
                    with contextlib.redirect_stdout(stream):
                        self.assertEqual(slr.cmd_outline(args), 0)
                    result = json.loads(stream.getvalue())
                    self.assertEqual('outline' in result, flag)
                    self.assertEqual(result['packet_id'], full['packet_id'])
                    self.assertEqual(result['outline_markdown'], full['outline_markdown'])
                    disk = json.loads((ws / '04_outline/review_packet.json').read_text())
                    self.assertEqual(disk['outline'], full['outline'])

    def test_subprocess_report_is_retained_and_caller_cwd_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            args = SimpleNamespace(workspace=str(ws), full=False, profile='fast')
            command = [sys.executable, '-c',
                       'import json,os; print(json.dumps({"status":"SUCCESS", "cwd":os.getcwd(),'
                       '"outline_markdown":"- Main", "outline":{"internal":"preserved"}}))']
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                rc = slr._exec_main_tool(args, command, 'fixture')
            result = json.loads(stream.getvalue())
            self.assertEqual(rc, 0)
            self.assertEqual(result['cwd'], str(Path.cwd()))
            self.assertNotIn('outline', result)
            self.assertEqual(json.loads(Path(result['cli_report']).read_text())['outline'],
                             {'internal': 'preserved'})


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name)
        self.calls = []
        self.responses = {}
        self.retrieval = {'output_count': 40, 'corpus_plan': {'combined_target': 40},
                          'flagged_for_review': [], 'must_include': [],
                          'outside_time_range_retained': {'count': 2, 'papers': ['old1', 'old2']}}
        self.save_retrieval()

    def save_retrieval(self):
        atomic_json(self.ws / '02_retrieval/retrieval_report.json', self.retrieval)

    def runner(self, ws, command):
        self.calls.append(command)
        stage = command[-1]
        state = json.loads((ws / '_status/workflow.json').read_text())
        self.assertEqual(state['status'], 'RUNNING')
        if stage in self.responses:
            return self.responses[stage]
        if stage == 'review-packet':
            return 0, {'status': 'SUCCESS', 'outline_review': 'auto',
                       'outline': {'internal': 'complete'}, 'outline_markdown': '- Main',
                       'packet_id': 'unchanged'}
        if stage == 'publish':
            return 0, {'status': 'SUCCESS', 'deliverable': str(ws / '06_output/survey.pdf')}
        if stage == 'verify_postcheck':
            return 0, {'status': 'SUCCESS', 'visual_review_required': True,
                       'pages_to_read': ['page1.png'], 'visual_review_complete': False}
        return 0, {'status': 'SUCCESS'}

    def run_phase(self, phase='evidence', start=None):
        return advance(self.ws, phase, start, self.runner)

    def test_default_evidence_stops_before_fulltext_authorization(self):
        result = self.run_phase()
        self.assertEqual(self.calls, [['run', 'retrieval_adapt']])
        self.assertEqual(result['boundary'], 'fulltext_authorization')
        self.assertEqual(result['retrieval']['outside_time_range_retained']['count'], 2)
        self.assertEqual(json.loads((self.ws / '_status/workflow.json').read_text()), result)

    def test_authorized_fulltext_resume_reaches_outline_display(self):
        result = self.run_phase(start='fulltext')
        self.assertEqual(self.calls, [['run', 'fulltext'], ['run', 'processing'],
                         ['outline', 'generate'], ['outline', 'review-packet']])
        self.assertEqual(result['boundary'], 'outline_display')
        self.assertIn('outline', result['result'])
        self.assertNotIn('outline', compact(result)['result'])

    def test_partial_retrieval_stops_before_acquisition(self):
        self.responses['retrieval_adapt'] = (0, {'status': 'PARTIAL_SUCCESS', 'status_reason': 'thin corpus'})
        result = self.run_phase()
        self.assertEqual(result['boundary'], 'retrieval_review')
        self.assertEqual(result['result']['status_reason'], 'thin corpus')
        self.assertEqual(len(self.calls), 1)

    def test_named_metadata_gaps_still_stop_for_main(self):
        for reason in ('venue unknown','citation count unavailable'):
            with self.subTest(reason=reason):
                self.calls = []
                self.retrieval['flagged_for_review'] = [{'paper_id': 'p1', 'reason': reason}]
                self.save_retrieval()
                result = self.run_phase()
                self.assertEqual(result['boundary'], 'retrieval_review')

    def test_missing_required_paper_stops_even_on_success_status(self):
        self.retrieval['must_include'] = [{'title': 'Required paper', 'found': False}]
        self.save_retrieval()
        self.assertEqual(self.run_phase()['boundary'], 'retrieval_review')
        self.assertEqual(len(self.calls), 1)

    def test_abstract_fallback_continues_and_keeps_material_counts(self):
        self.responses['fulltext'] = (0, {'status': 'PARTIAL_SUCCESS',
            'material_counts': {'fulltext': 0, 'abstract_only': 40, 'no_text': 0}})
        result = self.run_phase(start='fulltext')
        self.assertEqual(result['boundary'], 'outline_display')
        self.assertEqual(compact(result)['fulltext']['material_counts']['abstract_only'], 40)

    def test_processing_gap_blocks_outline(self):
        self.responses['processing'] = (1, {'status': 'PARTIAL_SUCCESS',
            'ready_for_outline': False, 'issues': [{'paper_id': 'p3', 'reason': 'no_card'}]})
        result = self.run_phase(start='fulltext')
        self.assertEqual(result['boundary'], 'error')
        self.assertEqual(result['result']['issues'][0]['paper_id'], 'p3')
        self.assertEqual(self.calls[-1], ['run', 'processing'])

    def test_explicit_resume_does_not_repeat_upstream(self):
        self.assertEqual(self.run_phase(start='processing')['boundary'], 'outline_display')
        self.assertEqual(self.calls[0], ['run', 'processing'])
        self.assertEqual(len(self.calls), 3)

    def test_redisplay_resume_only_reads_packet_but_outline_start_executes_generation(self):
        self.assertEqual(self.run_phase(start='review-packet')['boundary'], 'outline_display')
        self.assertEqual(self.calls, [['outline', 'review-packet']])
        self.calls.clear()
        self.assertEqual(self.run_phase(start='outline')['boundary'], 'outline_display')
        self.assertEqual(self.calls, [['outline', 'generate'], ['outline', 'review-packet']])

    def test_publish_requires_main_inspection_and_preserves_paths(self):
        result = self.run_phase('publish')
        self.assertEqual(self.calls, [['manuscript', 'publish'], ['run', 'verify_postcheck']])
        self.assertEqual(result['boundary'], 'pdf_inspection')
        self.assertEqual(result['result']['pages_to_read'], ['page1.png'])
        self.assertFalse(result['result']['visual_review_complete'])
        self.assertTrue(compact(result)['deliverable'].endswith('survey.pdf'))

    def test_render_failure_is_still_an_inspection_boundary(self):
        self.responses['verify_postcheck'] = (0, {'status': 'SUCCESS', 'visual_review_required': True,
            'pages_to_read': [], 'render_error': 'PDF rendering unavailable'})
        result = self.run_phase('publish')
        self.assertEqual(result['boundary'], 'pdf_inspection')
        self.assertIn('unavailable', result['result']['render_error'])

    def test_markdown_has_no_pdf_boundary(self):
        self.responses['verify_postcheck'] = (0, {'status': 'SUCCESS', 'visual_review_required': False})
        self.assertEqual(self.run_phase('publish')['boundary'], 'delivery')

    def test_publication_error_does_not_run_postcheck(self):
        self.responses['publish'] = (1, {'status': 'FAILED', 'code': 'LATEX_COMPILE_ERROR'})
        self.assertEqual(self.run_phase('publish')['status'], 'FAILED')
        self.assertEqual(len(self.calls), 1)

    def test_exception_records_failure_instead_of_stale_running_state(self):
        def broken(ws, command):
            raise OSError('named failure')
        result = advance(self.ws, 'evidence', runner=broken)
        self.assertEqual(result['status'], 'FAILED')
        self.assertEqual(result['result']['message'], 'named failure')
        self.assertEqual(json.loads((self.ws / '_status/workflow.json').read_text())['status'], 'FAILED')

    def test_real_cli_runner_invalid_input_is_machine_readable(self):
        rc, result = execute(self.ws, ['outline', 'review-packet'])
        self.assertNotEqual(rc, 0)
        self.assertEqual(result['status'], 'FAILED')


if __name__ == '__main__':
    unittest.main()
