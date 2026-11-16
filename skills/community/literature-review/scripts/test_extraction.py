"""Review orchestration contracts; shared asset quality belongs to Serve."""
from __future__ import annotations

import asyncio
import copy
from dataclasses import asdict
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
sys.path.insert(0, str(ROOT / 'scripts' / 'processing'))
import run_pipeline  # noqa: E402
from paper_materials import readiness, source_identity  # noqa: E402
from progress import FatalLLMError, PipelineStop, PipelineStoppedError  # noqa: E402
from step0_load import load_inputs  # noqa: E402
from task_contract import atomic_json  # noqa: E402
from diagnostics import EvidenceLog  # noqa: E402

TEXT = '#1 Direct result\n  dataset | score\n  Example | 12%\n#2 Necessary conditions'
PAPER = {'title': 'Example', 'abstract': 'First sentence. Second sentence.', 'relevance_level': 'L1', 'paper_type': 'method'}
INFO = {'info_type': 'origin_latex', 'sentences': TEXT, 'arxiv_id': 'fixture'}
ASSET = {'l1': {'card': {'abstract': PAPER['abstract']},
                'extraction_quality': {'status': 'READY'}, 'completeness': {'complete': True}},
         'metadata': {'coverage': {'complete': False, 'evidence_kind': 'abstract'}},
         'revision': 'asset-revision'}


class ScriptedClient:
    timeout = 10
    uses_runtime = True

    def __init__(self, outputs):
        self.outputs = outputs
        self.calls = []

    async def chat(self, system, user, max_tokens=None, json_mode=False):
        self.calls.append((system, user))
        value = self.outputs[min(len(self.calls) - 1, len(self.outputs) - 1)]
        if isinstance(value, BaseException):
            raise value
        return json.dumps(value), {'prompt_tokens': 10, 'completion_tokens': 2}


class ExtractionTests(unittest.IsolatedAsyncioTestCase):
    async def test_block_responses_keep_structured_diagnostics(self):
        payload = {'card': {'problem': 'actual problem'}, 'common_fields': {'tldr': 'actual summary'}, 'source_map': {}}

        class BlockClient:
            uses_runtime = True
            timeout = 10

            async def chat(self, system, user, max_tokens=None, json_mode=False):
                self.mode = json_mode
                return ''.join(f'<{field}>' + json.dumps(value) + f'</{field}>'
                               for field, value in payload.items()), {'prompt_tokens': 10, 'completion_tokens': 2}

        client = BlockClient()

        async def material(source, bridge, **kwargs):
            await bridge.chat('system', 'input', json_mode=False)
            return copy.deepcopy(ASSET)

        with tempfile.TemporaryDirectory() as folder:
            diagnostic = EvidenceLog(folder, 'processing')
            with patch.object(run_pipeline, 'material_asset', AsyncMock(side_effect=material)):
                await run_pipeline._process_single_paper(client, 'paper', PAPER, None, 'abstract', 'method', diagnostic=diagnostic)
            events = [json.loads(line) for line in diagnostic.events.read_text().splitlines()]
            response = next(item for item in events if item['event'] == 'response_received')
            captured = json.loads((Path(folder).resolve() / response['response_ref']).read_text())
            self.assertEqual(captured['parsed'], payload)
            self.assertFalse(client.mode)

    async def test_partial_response_survives_stream_failure(self):
        class BrokenStream:
            uses_runtime = True
            supports_processing_capture = True
            timeout = 10

            async def chat(self, system, user, max_tokens=None, json_mode=False, _capture=None):
                _capture.update(partial_response='{"card":', finish_reason=None, usage={})
                raise RuntimeError('stream interrupted')

        events = []
        with self.assertRaises(run_pipeline.llm_call.LLMCallError):
            await run_pipeline.llm_call._llm_call(BrokenStream(), 'system', 'user', expect_json=True,
                observer=lambda event, **values: events.append((event, values)))
        partial = next(values for event, values in events if event == 'partial_response')
        self.assertEqual(partial['response'], '{"card":')
        self.assertTrue(any(event == 'request_failed' for event, values in events))

    async def test_failed_extraction_keeps_responses_and_returned_repair_fields(self):
        outputs = [{'card': {'problem': 'partial'}}, {'fields': {'unexpected': 'repair value'}}]
        client = ScriptedClient(outputs)

        async def material(source, bridge, **kwargs):
            for phase in ('extract', 'repair'):
                await bridge.chat('system', phase, json_mode=True)
            raise run_pipeline.ComprehensionError(run_pipeline.EXTRACTION_INCOMPLETE,
                diagnostics={'l1': {'card': {'problem': 'partial'}}})

        with tempfile.TemporaryDirectory() as folder:
            diagnostic = EvidenceLog(folder, 'processing')
            prepared = run_pipeline.prepare_abstract('title', 'source')
            source_file = Path(folder) / 'source.pdf'
            source_file.write_bytes(b'source')
            info = {'source_file': str(source_file), 'parse_report': {'reading_input': asdict(prepared)}}
            with patch.object(run_pipeline, 'material_asset', AsyncMock(side_effect=material)):
                with self.assertRaises(run_pipeline.ComprehensionError):
                    await run_pipeline._process_single_paper(client, 'paper', PAPER, info, 'full', 'method',
                                                             diagnostic=diagnostic)
            events = [json.loads(line) for line in diagnostic.events.read_text().splitlines()]
            responses = [item for item in events if item['event'] == 'response_received']
            self.assertEqual([item['call_number'] for item in responses], [1, 2])
            self.assertEqual(responses[1]['repair_fields'], ['unexpected'])
            captured = json.loads((Path(folder).resolve() / responses[1]['response_ref']).read_text())
            self.assertEqual(captured['parsed'], outputs[1])
            self.assertEqual(json.loads(captured['text']), outputs[1])
            self.assertTrue(any(item.get('kind') == 'extraction_failure' for item in events))

    async def test_shared_asset_delegation_preserves_card_identity_and_usage(self):
        client = ScriptedClient([{'ready': True}])
        usage = {}

        async def material(source, bridge, **kwargs):
            self.assertEqual(source.title, PAPER['title'])
            self.assertEqual(source.abstract, PAPER['abstract'])
            self.assertEqual(kwargs, {'paper_type': 'method', 'paper': PAPER, 'pdf_payload': None})
            for phase in ('classify', 'extract'):
                text, returned_usage = await bridge.chat('system', phase, json_mode=True)
                self.assertEqual(json.loads(text), {'ready': True})
                self.assertEqual(returned_usage, {'prompt_tokens': 10, 'completion_tokens': 2})
            self.assertEqual(len(bridge.records), 2)
            self.assertEqual(sum(record.input_tokens for record in bridge.records), 20)
            self.assertEqual(sum(record.output_tokens for record in bridge.records), 4)
            return copy.deepcopy(ASSET)

        with patch.object(run_pipeline, 'material_asset', AsyncMock(side_effect=material)) as call:
            result = await run_pipeline._process_single_paper(
                client, 'p', PAPER, None, 'abstract', 'method', usage_out=usage)
        self.assertEqual(call.await_count, 1)
        self.assertEqual(client.calls, [('system', 'classify'), ('system', 'extract')])
        self.assertEqual(usage, {'prompt_tokens': 20, 'completion_tokens': 4})
        self.assertIs(result[4], usage)
        self.assertEqual(result[1:4], (None, None, None))
        self.assertEqual(result[0], {
            **ASSET['l1'], 'paperId': 'p', 'title': PAPER['title'], 'abstract': PAPER['abstract'],
            'authors': [], 'year': None, 'source_coverage': ASSET['metadata']['coverage'],
            'asset_revision': ASSET['revision'], 'has_parse_dict': False})

    async def test_prepared_input_and_original_bytes_reach_the_asset_boundary(self):
        prepared = run_pipeline.prepare_abstract('Frozen title', 'Frozen source')
        with tempfile.TemporaryDirectory() as folder:
            source_file = Path(folder) / 'paper.pdf'
            payload = b'original source bytes for the orchestration port'
            source_file.write_bytes(payload)
            info = {'parse_report': {'reading_input': asdict(prepared)}, 'source_file': str(source_file)}
            with patch.object(run_pipeline, 'material_asset', AsyncMock(return_value=copy.deepcopy(ASSET))) as call:
                result = await run_pipeline._process_single_paper(None, 'p', PAPER, info, 'full', 'method')
            supplied = call.call_args.args[0]
            self.assertEqual(asdict(supplied), {**asdict(prepared), 'title': PAPER['title'], 'abstract': PAPER['abstract']})
            self.assertEqual(call.call_args.kwargs['pdf_payload'], payload)
            self.assertEqual(source_file.read_bytes(), payload)
            self.assertTrue(result[0]['has_parse_dict'])

    async def test_transport_errors_and_cancellation_are_not_wrapped(self):
        for error in (FatalLLMError(401, 'unauthorized'), PipelineStoppedError('stopped'),
                      RuntimeError('runtime failed'), asyncio.CancelledError()):
            cause = RuntimeError('original transport cause')
            error.__cause__ = cause
            with self.subTest(error=type(error)), patch.object(
                run_pipeline.llm_call, '_llm_call', AsyncMock(side_effect=error)
            ) as call:
                with self.assertRaises(type(error)) as caught:
                    await run_pipeline._process_single_paper(None, 'p', PAPER, INFO, 'full', 'method')
                self.assertIs(caught.exception, error)
                self.assertIs(caught.exception.__cause__, cause)
                self.assertEqual(call.await_count, 1)

    async def test_runtime_timeout_is_not_retried(self):
        client = ScriptedClient([TimeoutError('deadline')])
        with self.assertRaises(FatalLLMError):
            await run_pipeline._process_single_paper(client, 'p', PAPER, INFO, 'full', 'method')
        self.assertEqual(len(client.calls), 1)

    async def test_cancelled_pipeline_calls_no_client(self):
        stop = PipelineStop()
        stop.stop_event.set()
        client = ScriptedClient([])
        with self.assertRaises(PipelineStoppedError):
            await run_pipeline._process_single_paper(client, 'p', PAPER, INFO, 'full', 'method', stop=stop)
        self.assertEqual(client.calls, [])

    async def test_ready_card_is_reused_but_degraded_cards_and_retired_stages_are_not(self):
        stored = copy.deepcopy(ASSET['l1'])
        original = copy.deepcopy(stored)
        client = ScriptedClient([])
        info = {**INFO, 'paper_card': stored}
        with patch.object(run_pipeline, 'material_asset', AsyncMock(return_value=copy.deepcopy(ASSET))) as call:
            result = await run_pipeline._process_single_paper(client, 'p', PAPER, info, 'full', 'method')
            call.assert_not_called()
            self.assertEqual(result[0], {**stored, 'paperId': 'p'})
            self.assertEqual(result[1:4], (None, None, None))
            self.assertEqual(stored, original)
            for with_delta, with_ideation in ((True, False), (False, True)):
                with self.subTest(delta=with_delta, ideation=with_ideation), self.assertRaisesRegex(ValueError, 'L1 cards only'):
                    await run_pipeline._process_single_paper(
                        client, 'p', PAPER, info, 'full', 'method',
                        with_delta=with_delta, with_ideation=with_ideation)
            call.assert_not_called()
            stored['extraction_quality']['status'] = 'DEGRADED'
            await run_pipeline._process_single_paper(client, 'p', PAPER, info, 'full', 'method')
            self.assertEqual(call.await_count, 1)
        self.assertEqual(client.calls, [])


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name)
        atomic_json(self.ws / '02_retrieval/selected_paper.json', {'p': PAPER})
        atomic_json(self.ws / '02_retrieval/paper_info.json', {'p': INFO})
        atomic_json(self.ws / '03_process/cite_keys.json', {'p': 'example'})
        self.args = SimpleNamespace(folder=str(self.ws), output_dir=None, concurrency=1,
            relevance=None, limit=None, with_source_map=True,
            reclassify_type=False, max_retries=2, llm_retries=2)

    def test_saved_failure_blocks_readiness_and_resume_does_not_extract(self):
        card = {'paperId': 'p', 'card': None, 'extraction_quality': {'status': 'DEGRADED'},
                'completeness': {'complete': False}, 'material_sha256': source_identity(PAPER, INFO)}
        target = self.ws / '03_process/paper_cards.json'
        atomic_json(target, {'p': card})
        before = target.read_bytes()
        self.assertFalse(readiness(self.ws)['ready_for_outline'])
        self.assertEqual(readiness(self.ws)['next_action'], 'inspect_saved_extraction')
        with patch.object(run_pipeline, '_create_llm', side_effect=AssertionError('resume starts a model')) as create:
            with patch('sys.stdout', io.StringIO()) as output:
                asyncio.run(run_pipeline._run_async(self.args))
        create.assert_not_called()
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'PARTIAL_SUCCESS')
        self.assertEqual(result['processed'], 0)
        self.assertEqual(result['quality_blocked_ids'], ['p'])
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse((self.ws / '03_process/_history').exists())

    def test_empty_failed_extraction_is_preserved_but_changed_source_still_invalidates(self):
        card = {'paperId': 'p', 'card': None, 'extraction_quality': {'status': 'DEGRADED'},
                'material_sha256': source_identity(PAPER, INFO)}
        atomic_json(self.ws / '03_process/paper_cards.json', {'p': card})
        args = (str(self.ws / '02_retrieval'), str(self.ws / '03_process'))
        self.assertEqual(load_inputs(*args)[-1], [])
        self.assertFalse(readiness(self.ws)['ready_for_outline'])
        atomic_json(self.ws / '02_retrieval/paper_info.json', {'p': {**INFO, 'sentences': '#1 Changed'}})
        self.assertEqual(len(load_inputs(*args)[-1]), 1)

    def test_legacy_card_without_quality_fields_is_not_revalidated(self):
        atomic_json(self.ws / '03_process/paper_cards.json', {'p': {'card': {'old': 'valid'}}})
        self.assertEqual(load_inputs(str(self.ws / '02_retrieval'), str(self.ws / '03_process'))[-1], [])
        self.assertTrue(readiness(self.ws)['ready_for_outline'])


class AbstractFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_incomplete_abstract_extraction_keeps_original_evidence(self):
        error = run_pipeline.ComprehensionError(run_pipeline.EXTRACTION_INCOMPLETE)
        with patch.object(run_pipeline, 'material_asset', AsyncMock(side_effect=error)):
            result = await run_pipeline._process_single_paper(None, 'p', PAPER, None, 'abstract', 'method')
        card = result[0]
        self.assertEqual(card['card']['abstract'], PAPER['abstract'])
        self.assertEqual(card['reading_depth'], 'abstract_only')
        self.assertEqual(card['material_sha256'], source_identity(PAPER, {}))
        self.assertNotIn('asset_revision', card)

    async def test_other_extraction_errors_are_preserved(self):
        with patch.object(run_pipeline, 'material_asset', AsyncMock(side_effect=TimeoutError('deadline'))):
            with self.assertRaises(TimeoutError):
                await run_pipeline._process_single_paper(None, 'p', PAPER, None, 'abstract', 'method')

    async def test_incomplete_fulltext_extraction_still_blocks(self):
        error = run_pipeline.ComprehensionError(run_pipeline.EXTRACTION_INCOMPLETE)
        with tempfile.TemporaryDirectory() as folder:
            pdf = Path(folder) / 'paper.pdf'
            pdf.write_bytes(b'original pdf bytes')
            info = {'parse_report': {'reading_input': {'title': 'Example'}}, 'source_file': str(pdf)}
            with patch.object(run_pipeline, 'ReadingInput'), patch.object(
                run_pipeline, 'material_asset', AsyncMock(side_effect=error)
            ):
                with self.assertRaises(run_pipeline.ComprehensionError):
                    await run_pipeline._process_single_paper(None, 'p', PAPER, info, 'full', 'method')


if __name__ == '__main__':
    unittest.main()
