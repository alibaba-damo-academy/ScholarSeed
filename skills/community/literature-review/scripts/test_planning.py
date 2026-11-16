import asyncio
import contextlib
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from task_contract import configure, digest, read_request
from local_papers import sizing
from planning import complete, decide, packet, require_plan, resolve
from structure_checks import outline_structure_errors
from task_contract import publication_view
from main_view import compact
from input_contracts import input_error
from budget import elapsed, measure, timing
from scripted_generation import invoke
from stream_progress import StreamProgress
import slr


class PlanningTest(unittest.TestCase):
    def test_overrun_progress_reports_current_stage_without_stopping(self):
        configure(self.workspace, {'execution': {'budget_seconds': 1}})
        record = self.workspace / '_status/budget.json'
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps({'intervals': [[0, 5570]]}))
        folder = self.workspace / '_logs/llm/progress'
        folder.mkdir(parents=True)
        progress = StreamProgress(self.workspace, 'quick_draft', folder, 1)
        with contextlib.redirect_stderr(io.StringIO()) as output:
            progress.event('streaming')
        report = json.loads(output.getvalue())
        self.assertEqual(report['stage'], 'quick_draft')
        self.assertEqual(report['state'], 'streaming')
        self.assertTrue(report['processing_time']['over_expected_time'])

    def test_stage_keeps_its_timeout_after_expected_time_has_passed(self):
        configure(self.workspace, {'execution': {'budget_seconds': 1}})
        record = self.workspace / '_status/budget.json'
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps({'intervals': [[0, 5570]]}))
        source = self.workspace / '05_generation/full_draft_v2.md'
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text('# Prepared draft')
        args = SimpleNamespace(profile='fixture', workspace=str(self.workspace),
                               stage='verify_postcheck', dry_run=False, full=True)
        stage = {'id': args.stage, 'steps': [['probe']], 'timeout_sec': 77,
                 'status': {'kind': 'trailing_json'}}
        with patch('slr.find_stage', return_value=stage), patch('slr.stage_env', return_value={}), \
                patch('slr.run_command', return_value=(0, '{"status":"SUCCESS"}')) as command, \
                patch('slr.emit'):
            slr._cmd_run(args)
        self.assertEqual(command.call_args.args[4], stage['timeout_sec'])

    def test_elapsed_estimate_does_not_block_generation_or_shorten_request_deadline(self):
        configure(self.workspace, {'execution': {'budget_seconds': 1}})
        atomic = self.workspace / '_status/budget.json'
        atomic.parent.mkdir(parents=True, exist_ok=True)
        atomic.write_text(json.dumps({'intervals': [[0, 5570]]}))
        config = {'request_deadline_sec': 600}
        with patch('scripted_generation._invoke', new_callable=AsyncMock, return_value={'status': 'SUCCESS'}) as generate:
            result = asyncio.run(invoke(self.workspace, 'quick_draft', [], config))
        self.assertEqual(result['status'], 'SUCCESS')
        self.assertEqual(generate.call_args.args[3], config)

    def bridge_response(self, receipt):
        return {'ok': True, 'confirmation': receipt, 'next_action': 'Actual product guidance.'}

    def test_resolve_consumes_complete_response_once_and_preserves_original(self):
        response = self.bridge_response(self.receipt(packet(self.workspace), 'Proceed.'))
        result = resolve(self.workspace, response, action='proceed')
        require_plan(self.workspace)
        self.assertEqual(result['receipt'], response['confirmation'])
        self.assertEqual(json.loads((self.workspace / result['source_response']).read_text()), response)
        self.assertEqual(resolve(self.workspace, response, action='proceed'), result)
        with self.assertRaises(ValueError):
            resolve(self.workspace, response, action='pause')

    def test_resolve_rejects_reconstructed_answers_and_untyped_envelopes(self):
        response = self.bridge_response(self.receipt(packet(self.workspace), 'Proceed.'))
        response['confirmation']['decision']['answers'] = {'wrong-request': 'Proceed.'}
        for value in (response, {'content': [{'text': json.dumps(response)}]}, response['confirmation']):
            with self.subTest(value=value), self.assertRaises(ValueError):
                resolve(self.workspace, value, action='proceed')
        with self.assertRaises(ValueError):
            require_plan(self.workspace)

    def test_resolve_timeout_and_cancellation_cannot_be_overridden(self):
        receipt = self.receipt(packet(self.workspace), timeout=True)
        receipt['deadline_at'] = receipt['started_at'] + 300
        response = self.bridge_response(receipt)
        with self.assertRaises(ValueError):
            resolve(self.workspace, response, action='proceed')
        self.assertTrue(resolve(self.workspace, response)['can_continue'])
        configure(self.workspace, {'language': 'CHINESE'})
        receipt = self.receipt(packet(self.workspace), 'ignored')
        receipt['decision'] = {'cancelled': True}
        response = self.bridge_response(receipt)
        with self.assertRaises(ValueError):
            resolve(self.workspace, response, action='proceed')
        self.assertEqual(resolve(self.workspace, response)['state'], 'cancelled')
        with self.assertRaises(ValueError):
            require_plan(self.workspace)

    def test_resolve_patch_resumes_same_interrupted_decision(self):
        response = self.bridge_response(self.receipt(packet(self.workspace), 'Use English.'))
        changes = {'language': 'ENGLISH', 'user_requests': ['Use English.'],
                   'effective_requirements': 'Use English with unchanged scope.'}
        with patch('planning.configure', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                resolve(self.workspace, response, action='proceed', patch=changes)
        with self.assertRaises(ValueError):
            require_plan(self.workspace)
        result = resolve(self.workspace, response, action='proceed', patch=changes)
        self.assertTrue(result['can_continue'])
        require_plan(self.workspace)
        self.assertEqual(read_request(self.workspace)['user_requests'], ['Use English.'])
        configure(self.workspace, {'publication': {'citation_style': 'ieee'}})
        with self.assertRaisesRegex(ValueError, 'stale'):
            resolve(self.workspace, response, action='proceed', patch=changes)

    def test_resolve_pause_keeps_execution_blocked_and_missing_action_changes_nothing(self):
        response = self.bridge_response(self.receipt(packet(self.workspace), 'Pause.'))
        with self.assertRaises(ValueError):
            resolve(self.workspace, response)
        self.assertFalse((self.workspace / '_status/plan_decision.json').exists())
        result = resolve(self.workspace, response, action='pause')
        self.assertEqual(result['state'], 'paused')
        self.assertEqual(resolve(self.workspace, response, action='pause'), result)
        with self.assertRaises(ValueError):
            require_plan(self.workspace)

    def test_compact_plan_hides_lineage_payloads_but_keeps_diagnostics(self):
        value={'stage':'execution_plan','status':'SUCCESS','notice':'Use the current plan.',
               'outline_amendments':[{'before':{'request':'large'}}],
               'local_metadata_updates':[{'after':{'request':'large'}}]}
        self.assertEqual(compact(value),{'stage':'execution_plan','status':'SUCCESS',
                                        'notice':'Use the current plan.'})
        self.assertIn('local_metadata_updates',value)

    def test_quick_defaults_to_fifteen_minutes_and_preserves_explicit_budget(self):
        self.assertEqual(read_request(self.workspace)['execution']['budget_seconds'], 900)
        configure(self.workspace, {'execution': {'budget_seconds': 600}})
        self.assertEqual(read_request(self.workspace)['execution']['budget_seconds'], 600)

    def test_markdown_does_not_claim_a_latex_template(self):
        configure(self.workspace,{'publication':{'format':'markdown','template':'ctexart'}})
        self.assertIsNone(publication_view(read_request(self.workspace))['template'])

    def test_decision_input_does_not_collide_with_owned_state(self):
        plan=packet(self.workspace)
        submitted={'packet_id':plan['packet_id'],'action':'proceed'}
        source=self.workspace/'01_input/plan_decision.json'
        source.write_text(json.dumps(submitted))
        with self.assertRaises(ValueError):
            decide(self.workspace,submitted)
        complete(self.workspace,self.receipt(plan,'Proceed.'))
        decide(self.workspace,submitted)
        require_plan(self.workspace)
        self.assertEqual(json.loads(source.read_text()),submitted)

    def test_plan_errors_do_not_require_a_sample_payload(self):
        for operation in ('writing.plan-complete','writing.plan-decide'):
            with self.subTest(operation=operation):
                result=input_error(operation,ValueError('invalid plan receipt'))
                self.assertEqual(result['code'],'INPUT_INVALID')
                self.assertEqual(result['message'],'invalid plan receipt')

    def test_processing_intervals_exclude_gaps_and_merge_overlap(self):
        self.assertEqual(elapsed([[20,30],[0,10],[5,7],[8,15]]),25)
        with patch('budget.time.time',side_effect=[100,120,300,310]):
            with measure(self.workspace):
                pass
            with measure(self.workspace):
                pass
        self.assertEqual(timing(self.workspace), {'elapsed_seconds': 30, 'expected_seconds': 900,
                                                'over_expected_time': False})
        self.assertTrue(timing(self.workspace, active_seconds=900)['over_expected_time'])

    def test_pending_amendment_does_not_approve_unrelated_later_changes(self):
        plan=packet(self.workspace)
        complete(self.workspace,self.receipt(plan,'Use English.'))
        value={'packet_id':plan['packet_id'],'action':'proceed','patch':{
            'language':'ENGLISH','user_requests':['Use English.'],'effective_requirements':'Use English with the same scope.'}}
        with patch('planning.configure',side_effect=OSError('interrupted write')):
            with self.assertRaises(OSError):
                decide(self.workspace,value)
        configure(self.workspace,{'publication':{'citation_style':'ieee'}})
        with self.assertRaisesRegex(ValueError,'task changed'):
            decide(self.workspace,value)
        with self.assertRaises(ValueError):
            require_plan(self.workspace)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        configure(self.workspace, {
            'intent': 'Write one related work section from these papers.',
            'output_scope': 'section',
            'execution': {'mode': 'quick'},
            'deliverable': {'kind': 'related_work', 'unit': 'chapter'},
            'sources': {'policy': 'provided_only', 'refs':['literature:one']},
            'publication': {'format': 'markdown'},
        })

    def receipt(self, plan, answer=None, timeout=False):
        return {
            'packet_id': plan['packet_id'], 'snapshot_id': digest(plan['snapshot']),
            'request_id': 'actual-host-request', 'started_at': time.time() - 301,
            'deadline_at': time.time() - 1,
            'decision': {'timed_out': True} if timeout else {
                'answers': {'actual-host-request': answer}},
        }

    def test_default_chapter_concurrency_and_explicit_override(self):
        self.assertEqual(read_request(self.workspace)['chapter_concurrency'], 5)
        configure(self.workspace, {'chapter_concurrency': 2})
        self.assertEqual(read_request(self.workspace)['chapter_concurrency'], 2)

    def test_plan_needs_no_outline_and_repeated_packet_is_stable(self):
        first = packet(self.workspace)
        self.assertEqual(first['packet_id'], packet(self.workspace)['packet_id'])
        self.assertEqual(first['snapshot']['request']['execution']['mode'], 'quick')
        self.assertFalse((self.workspace / '04_outline/outline.json').exists())
        with self.assertRaises(ValueError):
            require_plan(self.workspace)

    def test_provided_only_plan_requires_bound_materials_before_confirmation(self):
        configure(self.workspace,{'sources':{'policy':'provided_only'}})
        with self.assertRaisesRegex(ValueError,'sources.refs.*before plan confirmation'):
            packet(self.workspace)
        self.assertFalse((self.workspace/'01_input/plan_packet.json').exists())
        references=['literature:'+str(index) for index in range(40)]
        configure(self.workspace,{'sources':{'policy':'provided_only','refs':references}})
        plan=packet(self.workspace)
        self.assertEqual(plan['snapshot']['request']['sources']['refs'],references)
        complete(self.workspace,self.receipt(plan,'Use the complete project library.'))
        decide(self.workspace,{'packet_id':plan['packet_id'],'action':'proceed'})
        require_plan(self.workspace)

    def test_actual_reply_and_partial_patch_continue_without_second_question(self):
        plan = packet(self.workspace)
        receipt = self.receipt(plan, 'Use English.')
        result = complete(self.workspace, receipt)
        self.assertFalse(result['can_continue'])
        decision = {'packet_id': plan['packet_id'], 'action': 'proceed',
                    'patch': {'language': 'ENGLISH', 'user_requests': ['Use English.'],
                              'effective_requirements': 'Keep the scope; use English.'}}
        decision_result=decide(self.workspace, decision)
        self.assertIn('Before importing papers',decision_result['next_action'])
        self.assertIn('Create or continue the execution tracker now',decision_result['next_action'])
        self.assertIn('doctor --scope full --no-network --json',decision_result['next_action'])
        self.assertIn('operation=get',decision_result['next_action'])
        self.assertIn('flat update_plan uses operation=get alone',decision_result['next_action'])
        self.assertIn('For flat create, read get again',decision_result['next_action'])
        self.assertIn('Do not infer protocol from get.actions',decision_result['next_action'])
        self.assertIn('already in_progress, continue its work without another mutation',decision_result['next_action'])
        self.assertIn('complete tree',decision_result['next_action'])
        self.assertIn('root content unchanged',decision_result['next_action'])
        require_plan(self.workspace)
        self.assertEqual(read_request(self.workspace)['sources']['policy'], 'provided_only')
        self.assertEqual(decide(self.workspace, decision)['state'], 'approved')

    def test_pause_and_cancel_never_authorize(self):
        plan = packet(self.workspace)
        complete(self.workspace, self.receipt(plan, 'Pause.'))
        decide(self.workspace, {'packet_id': plan['packet_id'], 'action': 'pause'})
        with self.assertRaises(ValueError):
            require_plan(self.workspace)
        with self.assertRaises(ValueError):
            decide(self.workspace, {'packet_id': plan['packet_id'], 'action': 'proceed'})

    def test_timeout_requires_real_expired_window_and_no_answer(self):
        plan = packet(self.workspace)
        receipt = self.receipt(plan, timeout=True)
        receipt['deadline_at'] = receipt['started_at'] + 300
        timeout_result=complete(self.workspace, receipt)
        self.assertIn('Before importing papers',timeout_result['next_action'])
        self.assertIn('doctor --scope full --no-network --json',timeout_result['next_action'])
        self.assertIn('operation=get',timeout_result['next_action'])
        require_plan(self.workspace)
        self.assertEqual(complete(self.workspace, receipt)['state'], 'approved')
        self.assertFalse((self.workspace / '04_outline/approval.json').exists())

    def test_stale_receipt_cannot_approve_changed_task(self):
        plan = packet(self.workspace)
        configure(self.workspace, {'publication': {'citation_style': 'author_year'}})
        with self.assertRaises(ValueError):
            complete(self.workspace, self.receipt(plan, 'Proceed.'))

    def test_replayed_approval_does_not_authorize_a_later_task_revision(self):
        plan=packet(self.workspace)
        receipt=self.receipt(plan,'Proceed.')
        complete(self.workspace,receipt)
        decide(self.workspace,{'packet_id':plan['packet_id'],'action':'proceed'})
        configure(self.workspace,{'publication':{'citation_style':'author_year'}})
        with self.assertRaisesRegex(ValueError,'stale task'):
            complete(self.workspace,receipt)

    def test_provided_only_never_supplements(self):
        self.assertEqual(sizing(3, read_request(self.workspace))['search_target'], 0)
        with self.assertRaises(ValueError):
            sizing(0, read_request(self.workspace))

    def test_scope_is_structural_not_a_prompt_only_promise(self):
        request = read_request(self.workspace)
        self.assertTrue(outline_structure_errors(request, {'outline_tree': []}))
        self.assertTrue(outline_structure_errors(request, {'outline_tree': [
            {'section_id': '1', 'title': 'A'}, {'section_id': '2', 'title': 'B'}]}))
        self.assertEqual(outline_structure_errors(request, {'outline_tree': [
            {'section_id': '1', 'title': 'Related work'}]}), [])
        request['deliverable']['unit']='paragraph'
        self.assertTrue(outline_structure_errors(request,{'outline_tree':[],'survey_title':'Invented title'}))
        self.assertEqual(outline_structure_errors(request,{'outline_tree':[],'survey_title':''}),[])

    def test_deep_is_rejected_without_changing_task(self):
        before = read_request(self.workspace)
        with self.assertRaises(ValueError):
            configure(self.workspace, {'execution': {'mode': 'deep'}})
        self.assertEqual(before, read_request(self.workspace))

    def test_word_uses_its_actual_template_and_compact_receipt(self):
        configure(self.workspace, {'execution':{'mode':'standard'},'publication': {'format':'docx','template':'ctexart'}})
        self.assertEqual(publication_view(read_request(self.workspace))['template'], 'word')
        plan=packet(self.workspace)
        view=compact(plan)
        self.assertNotIn('snapshot',view)
        self.assertEqual(view['publication']['format'],'docx')
        self.assertIn('snapshot',plan)


if __name__ == '__main__':
    unittest.main()
