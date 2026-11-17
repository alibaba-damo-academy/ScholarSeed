"""Client-controlled generation handoff and offline, source-bound acceptance."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cpes_machine import writer
from cpes_machine.markdown import MarkdownPreview, parse_markdown
from cpes.contracts import CpesError
from pdf_fixture import simple_pdf
from reading_pipeline import prepare, load_index, resolve
from source_ids import display_source_id


HOST_ENV = {'SCHOLARSEED_SKILL_PYTHON': '/host/skill-python'}


class HostWriterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        pdf = self.root / 'paper.pdf'
        simple_pdf(pdf)
        prepare(pdf, self.root / 'reading')
        self.request = self.root / 'request.json'
        self.result = self.root / 'writing'
        self.response = self.root / 'request-response.json'
        self.host = patch.dict(os.environ, HOST_ENV, clear=True)
        self.host.start()
        self.addCleanup(self.host.stop)

    def prepare_request(self):
        return writer.prepare_request(self.root / 'reading/reading.json', self.request)

    def test_text_first_preserves_failed_provenance_without_inventing_a_map(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        text = '##### Note\n\nAn intact paragraph. [[hint:reader_thought|B001]]'
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True, preserve_text=True)
        self.assertTrue(result['ok'])
        self.assertEqual(result['provenance_status'], 'unverified')
        self.assertEqual(Path(result['raw_note']).read_text(), text)
        self.assertNotIn('source_map', result)
        self.assertFalse((self.result / 'final').exists())
        reused = writer.accept(self.request, self.response, self.result, publish_final=True, preserve_text=True)
        self.assertTrue(reused['reused'])
        self.assertEqual(reused['raw_note'], result['raw_note'])
        with self.assertRaises(ValueError):
            writer.accept(self.request, self.response, self.result, publish_final=True)
        Path(result['raw_note']).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'changed'):
            writer.accept(self.request, self.response, self.result, preserve_text=True)

    def test_text_first_never_accepts_incomplete_empty_or_changed_input(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        for response in ({'output_text': 'Partial', 'status': 'failed'}, {'output_text': ''}):
            self.response.write_text(json.dumps({**response, 'model_key': 'qwen'}))
            with self.assertRaises(ValueError):
                writer.accept(self.request, self.response, self.result, preserve_text=True)
        self.response.write_text(json.dumps({'output_text': 'Intact', 'model_key': 'qwen'}))
        with patch.object(writer, 'load_request_data_check', side_effect=ValueError('changed input')):
            with self.assertRaisesRegex(ValueError, 'changed input'):
                writer.accept(self.request, self.response, self.result, preserve_text=True)

    def write_response(self, source='B00001'):
        draft = {'title': 'Forecast', 'sections': [{'title': '', 'paragraphs': [{
            'text': 'A probabilistic forecast.', 'source_ids': [source],
            'identity': 'paper_summary'}]}], 'omissions': []}
        self.response.write_text(json.dumps({'output_text': json.dumps(draft), 'model_key': 'profile:qwen',
            'usage': {'input_tokens': 31, 'output_tokens': 8}, 'elapsed_seconds': 2.0,
            'timings': {'generation_seconds': 1.5}}), encoding='utf-8')

    def test_markdown_request_and_accept_preserve_prose_and_local_provenance(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        request = writer.load_request(self.request)
        self.assertNotIn('schema', request)
        self.assertEqual(request['output_format'], 'markdown')
        self.assertEqual(request['preview']['format'], 'markdown')
        text = ('#### Forecast\n\nOriginal paper  \nRavuri et al. · Nature · 2021 [[hint:paper_summary|B00001]]\n\n'
                'A "complete" quotation. [[hint:model_explanation|B00001]]\n\n'
                '##### Mechanism\n\nA final sentence. [[hint:paper_summary|B00001]]')
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        note = Path(result['note']).read_text()
        self.assertIn('A "complete" quotation.', note)
        self.assertNotIn('[[hint:', note)
        preserved = writer.accept(self.request, self.response, self.result, publish_final=True, preserve_text=True)
        self.assertTrue(preserved['reused'])
        self.assertEqual(Path(preserved['raw_note']).read_text(), text)
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual(mapping['paragraphs'][1]['source_ids'], ['B00001'])
        self.assertEqual(mapping['paragraphs'][1]['identity'], 'model_explanation')
        self.assertEqual(json.loads(self.response.read_text())['output_text'], text)

    def test_markdown_request_hides_paragraph_bindings_in_host_preview(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        request = writer.load_request(self.request)
        self.assertNotIn('schema', request)
        marker = request['preview']['hidden_marker']
        self.assertEqual(marker['start'], '[[hint:')
        self.assertEqual(marker['end'], ']]')
        self.assertIn('[[mixed:', marker['alternative_starts'])
        self.assertIn('[[hint:model_explanation|B001,A003,A008]]', request['prompt'])
        self.assertNotIn('Count every later prose paragraph', request['prompt'])

    def test_inline_sources_preserve_many_to_many_reading_links(self):
        pdf = self.root / 'marked.pdf'
        simple_pdf(pdf, annotations=True)
        notes = self.root / 'thoughts.txt'
        notes.write_text('A tentative idea about calibration.', encoding='utf-8')
        reading = prepare(pdf, self.root / 'marked-reading', notes=[notes])
        index = load_index(reading['index'])
        ids = [source['id'] for source in index['catalog']]
        self.assertTrue(all(any(sid.startswith(prefix) for sid in ids) for prefix in 'BAN'))
        aliases = ','.join(display_source_id(sid) for sid in ids)
        writer.prepare_request(reading['index'], self.request, output_format='markdown')
        prose = ['A "quoted" explanation with $L_R(\\theta)$.', 'A second connected explanation.']
        text = '#### Forecast\n\n' + '\n\n'.join(
            paragraph + f' [[hint:model_explanation|{aliases}]]' for paragraph in prose)
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(Path(result['note']).read_text(), '#### Forecast\n\n' + '\n\n'.join(prose) + '\n')
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual([p['source_ids'] for p in mapping['paragraphs']], [ids, ids])
        self.assertTrue(all(entry['used_in'] == ['p01', 'p02'] for entry in mapping['entries']))
        self.assertEqual(json.loads(self.response.read_text())['output_text'], text)

    def test_inline_binding_cannot_cover_two_unbound_paragraphs(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        text = '#### Forecast\n\nFirst claim.\n\nSecond claim. [[hint:paper_summary|B001]]'
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        with self.assertRaisesRegex(ValueError, 'Each Markdown paragraph needs its own source reference'):
            writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertFalse((self.result / 'final').exists())

    def test_inline_sources_bind_the_whole_markdown_paragraph_without_splitting_sentences(self):
        text = ('#### Forecast\n\nFirst claim[[hint:paper_summary|B001,A003]]. '
                'Reader context[[hint:reader_thought|A008,A003]]. A concluding sentence.\n\n'
                'Another paragraph. [[hint:paper_summary|A003,B002]]')
        paragraphs = parse_markdown(text)['sections'][0]['paragraphs']
        self.assertEqual(len(paragraphs), 2)
        self.assertEqual(paragraphs[0], {
            'text': 'First claim. Reader context. A concluding sentence.',
            'source_ids': ['B001', 'A003', 'A008'], 'identity': 'mixed'})
        self.assertEqual(paragraphs[1]['source_ids'], ['A003', 'B002'])
        with self.assertRaises(ValueError):
            parse_markdown(text + '\n\nAn independent unbound conclusion.')

    def test_inline_sources_preserve_heading_boundaries_and_literal_whitespace(self):
        text = ('#### Forecast\n\nThe value is `"x . y"`. [[hint:paper_summary|B001]]\n'
                '##### Next\nSecond [[hint:paper_summary|B002]].')
        sections = parse_markdown(text)['sections']
        self.assertEqual(sections[0]['paragraphs'][0]['text'], 'The value is `"x . y"`.')
        self.assertEqual(sections[1]['title'], 'Next')
        self.assertEqual(sections[1]['paragraphs'][0]['text'], 'Second.')
        self.assertEqual(sections[1]['paragraphs'][0]['source_ids'], ['B002'])

    def test_heading_levels_and_bare_citations_preserve_paragraph_bindings(self):
        for level in range(1, 7):
            with self.subTest(level=level):
                text = ('#' * level + ' Forecast\r\n\r\n### Mechanism\r\n'
                        'First [A017][B012]. More [A017, B013].\r\n\r\n'
                        'Second [A017].')
                draft = parse_markdown(text)
                self.assertEqual(draft['title'], 'Forecast')
                self.assertEqual(len(draft['sections']), 1)
                self.assertEqual(draft['sections'][0]['title'], 'Mechanism')
                self.assertEqual(draft['sections'][0]['paragraphs'], [
                    {'text': 'First. More.', 'source_ids': ['A017', 'B012', 'B013'],
                     'identity': 'model_explanation'},
                    {'text': 'Second.', 'source_ids': ['A017'], 'identity': 'model_explanation'}])

    def test_setext_headings_are_normalized_locally(self):
        draft = parse_markdown('Forecast\n===\n\nA claim [B001].\n\nMechanism\n---\n\nMore [B001].')
        self.assertEqual(draft['title'], 'Forecast')
        self.assertEqual(draft['sections'][1]['title'], 'Mechanism')

    def test_literal_citations_in_code_links_and_escapes_are_preserved(self):
        literals = ('`[A017]`', '[A017](https://example.com)',
                    '![A017](image.png)', r'\[A017]', '`[[hint:paper_summary|A017]]`',
                    '[label [A017]](https://example.com)',
                    r'\[[hint:paper_summary|A017]]',
                    '[literal [[hint:paper_summary|A017]]](https://example.com)')
        for literal in literals:
            with self.subTest(literal=literal):
                paragraph = parse_markdown('#### Forecast\n\nLiteral ' + literal + ' [B001].')['sections'][0]['paragraphs'][0]
                self.assertEqual(paragraph['source_ids'], ['B001'])
                self.assertEqual(paragraph['text'], 'Literal ' + literal + '.')
                with self.assertRaisesRegex(ValueError, 'Each Markdown paragraph'):
                    parse_markdown('#### Forecast\n\nLiteral ' + literal + '.')

    def test_sources_inside_emphasis_preserve_markdown_delimiters(self):
        paragraph = parse_markdown('#### Forecast\n\n**First [A017]** and *second [B001]*.')['sections'][0]['paragraphs'][0]
        self.assertEqual(paragraph['text'], '**First** and *second*.')
        self.assertEqual(paragraph['source_ids'], ['A017', 'B001'])
        for text, expected in (('**First [A017] [B001]**.', '**First**.'),
                               ('**[A017] First** [B001].', '**First**.')):
            with self.subTest(text=text):
                self.assertEqual(parse_markdown('#### Forecast\n\n' + text)['sections'][0]['paragraphs'][0]['text'], expected)

    def test_bare_sources_are_validated_before_publication(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        self.response.write_text(json.dumps({'output_text': '##### Forecast\n\nClaim [B001].', 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(Path(result['note']).read_text(), '#### Forecast\n\nClaim.\n')
        self.response.write_text(json.dumps({'output_text': '##### Forecast\n\nClaim [B99999].', 'model_key': 'qwen'}))
        with self.assertRaises(ValueError):
            writer.accept(self.request, self.response, self.root / 'unknown', publish_final=True)
        self.assertFalse((self.root / 'unknown/final').exists())

    def test_unsupported_blocks_are_not_silently_discarded(self):
        for extra in ('\n\n```\n[A017]\n```', '\n\n- List [A017].',
                      '\n\n[A017]: https://example.com'):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                parse_markdown('#### Forecast\n\nClaim [B001].' + extra)

    def test_opening_bibliography_blank_line_keeps_one_source_group(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        text = ('#### Forecast\n\nOriginal paper\n\nRavuri et al. · Nature · 2021 '
                '[[hint:paper_summary|B001]]\n\nA claim. [[hint:paper_summary|B001]]')
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(Path(result['note']).read_text(),
                         '#### Forecast\n\nOriginal paper  \nRavuri et al. · Nature · 2021\n\nA claim.\n')
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual(len(mapping['paragraphs']), 2)
        self.assertEqual(mapping['paragraphs'][0]['source_ids'], ['B00001'])
        self.assertEqual(json.loads(self.response.read_text())['output_text'], text)

    def test_bibliography_spacing_exception_does_not_merge_body_paragraphs(self):
        for body in (
            'First claim.\n\nSecond claim. [[hint:paper_summary|B001]]',
            'First claim. [[hint:paper_summary|B001]]\n\n'
            'Another claim.\n\nRavuri et al. · Nature · 2021 [[hint:paper_summary|B001]]',
            'Original paper\n\nRavuri et al. · Nature · 2021\n\n'
            'Another claim. [[hint:paper_summary|B001]]',
        ):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, 'Each Markdown paragraph'):
                parse_markdown('#### Forecast\n\n' + body)

    def test_markdown_without_valid_sources_cannot_publish_an_invented_map(self):
        for number, text in enumerate(('#### Note\n\nUnattributed paragraph.',
                                      '#### Note\n\nA claim. [[hint:paper_summary|B99999]]',
                                      '#### Note\n\nA claim. [[paper_summary:B99999]]')):
            request_path = self.root / f'markdown-{number}.json'
            writer.prepare_request(self.root / 'reading/reading.json', request_path, output_format='markdown')
            self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
            out = self.root / f'failed-{number}'
            with self.assertRaises(ValueError):
                writer.accept(request_path, self.response, out, publish_final=True)
            self.assertFalse((out / 'final').exists())

    def test_separate_sources_accept_plain_prose_and_bind_paragraph_order(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        text = ('#### Forecast\n\nOriginal paper  \nRavuri et al. · Nature · 2021\n\n'
                'A "complete" quotation.\n\n##### Mechanism\n\nA final sentence.\n\n'
                '[[SOURCE_MAP]]\n1 | paper_summary | B00001\n'
                '2 | model_explanation | B00001\n3 | paper_summary | B00001\n[[/SOURCE_MAP]]')
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        note = Path(result['note']).read_text()
        self.assertEqual(note, text.split('[[SOURCE_MAP]]')[0].rstrip() + '\n')
        self.assertNotIn('B00001', note)
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual([p['paragraph_id'] for p in mapping['paragraphs']], ['p01', 'p02', 'p03'])
        self.assertEqual(mapping['paragraphs'][1]['identity'], 'model_explanation')
        self.assertEqual(mapping['paragraphs'][1]['source_ids'], ['B00001'])
        self.assertEqual(json.loads(self.response.read_text())['output_text'], text)

    def test_separate_source_block_never_enters_character_stream_preview(self):
        pieces = []
        preview = MarkdownPreview(pieces.append)
        prose = '#### Forecast\n\nA "complete" sentence.\n\n'
        for character in prose + '[[SOURCE_MAP]]\n1 | paper_summary | B00001\n[[/SOURCE_MAP]]':
            preview.feed(character)
            self.assertNotIn('SOURCE', ''.join(pieces))
            self.assertNotIn('B00001', ''.join(pieces))
        self.assertEqual(''.join(pieces), prose)

    def test_separate_sources_reject_missing_duplicate_and_unknown_bindings(self):
        rows = ('', '1 | paper_summary | B99999',
                '1 | paper_summary | B00001\n1 | mixed | B00001',
                '2 | paper_summary | B00001')
        for number, row in enumerate(rows):
            request = self.root / f'separate-{number}.json'
            writer.prepare_request(self.root / 'reading/reading.json', request, output_format='markdown')
            self.response.write_text(json.dumps({'output_text':
                f'#### Forecast\n\nA claim.\n\n[[SOURCE_MAP]]\n{row}\n[[/SOURCE_MAP]]',
                'model_key': 'qwen'}))
            out = self.root / f'separate-failed-{number}'
            with self.assertRaises(ValueError):
                writer.accept(request, self.response, out, publish_final=True)
            self.assertFalse((out / 'final').exists())

    def test_repeated_ids_in_one_source_row_are_merged_without_losing_prose(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        self.response.write_text(json.dumps({'output_text':
            '#### Forecast\n\nA claim.\n\n[[SOURCE_MAP]]\n1 | paper_summary | B00001,B00001\n[[/SOURCE_MAP]]',
            'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(Path(result['note']).read_text(), '#### Forecast\n\nA claim.\n')
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual(mapping['paragraphs'][0]['source_ids'], ['B00001'])

    def test_colon_references_accept_and_preserve_the_same_source_map(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        text = ('#### Forecast\n\nA complete quotation. [[paper_summary:B00001]]\n\n'
                'A second paragraph. [[hint:model_explanation|B00001]]')
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(Path(result['note']).read_text(),
                         '#### Forecast\n\nA complete quotation.\n\nA second paragraph.\n')
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual(mapping['paragraphs'][0]['source_ids'], ['B00001'])
        self.assertEqual(mapping['paragraphs'][0]['identity'], 'paper_summary')
        self.assertEqual(json.loads(self.response.read_text())['output_text'], text)

    def test_colon_references_do_not_leak_from_character_stream(self):
        pieces = []
        preview = MarkdownPreview(pieces.append)
        text = 'Before. [[paper_summary:B050,B051,A048]] After. [[hint:model_explanation|B001]] [[other:value]]'
        for character in text:
            preview.feed(character)
            self.assertNotIn('paper_summary', ''.join(pieces))
            self.assertNotIn('B050', ''.join(pieces))
        self.assertEqual(''.join(pieces), 'Before.  After.  [[other:value]]')

    def test_sentence_punctuation_after_either_reference_is_preserved(self):
        writer.prepare_request(self.root / 'reading/reading.json', self.request, output_format='markdown')
        text = ('#### Forecast\n\nA complete quotation [[paper_summary:B00001]]。\n\n'
                'A second paragraph [[hint:paper_summary|B00001]].')
        self.response.write_text(json.dumps({'output_text': text, 'model_key': 'qwen'}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(Path(result['note']).read_text(),
                         '#### Forecast\n\nA complete quotation。\n\nA second paragraph.\n')

    def test_request_returns_controlled_tool_payload_and_ready_accept_arguments(self):
        result = self.prepare_request()
        self.assertEqual(result['generation'], {'capability': 'generation', 'operation': 'run', 'request': {
            'request_id': writer.load_request(self.request)['fingerprint'],
            'input_path': str(self.request), 'output_path': str(self.response)}})
        self.assertEqual(result['accept'], {'request': str(self.request), 'response': str(self.response),
            'out_dir': str(self.result), 'publish': True})
        self.assertEqual(result['model_calls'], 0)

    def test_host_request_freezes_only_prose_preview_paths(self):
        self.prepare_request()
        request = writer.load_request(self.request)
        self.assertEqual(request['preview'], {'format': 'markdown_fields', 'fields': [
            {'path': ['title'], 'kind': 'heading1'},
            {'path': ['sections', '*', 'title'], 'kind': 'heading2'},
            {'path': ['sections', '*', 'paragraphs', '*', 'text'], 'kind': 'paragraph'}]})

    def test_preview_metadata_tampering_breaks_frozen_request_binding(self):
        self.prepare_request()
        request = writer.load_request(self.request)
        request['preview']['fields'][0]['path'] = ['source_ids']
        self.request.write_text(json.dumps(request), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Writing request changed'):
            writer.load_request(self.request)

    def test_standalone_request_omits_preview_without_changing_writing_inputs(self):
        self.prepare_request()
        host_request = writer.load_request(self.request)
        standalone_path = self.root / 'standalone-request.json'
        with patch.dict(os.environ, {}, clear=True):
            writer.prepare_request(self.root / 'reading/reading.json', standalone_path)
        standalone = writer.load_request(standalone_path)
        self.assertNotIn('preview', standalone)
        for key in ('prompt', 'schema', 'images', 'index', 'index_fingerprint', 'additional_source_ids'):
            self.assertEqual(host_request[key], standalone[key], key)

    def test_client_run_never_attempts_codex_even_without_private_bridge_environment(self):
        self.prepare_request()
        with patch.object(writer, 'CodexBackend') as buffered, patch.object(writer, 'StreamingBackend') as streamed:
            with self.assertRaises(CpesError) as failure:
                writer.execute(self.request, self.result, on_text=lambda _: None)
        self.assertEqual(failure.exception.code, 'host_controlled_generation_required')
        buffered.assert_not_called()
        streamed.assert_not_called()
        self.assertFalse(self.result.exists())

    def test_client_model_override_is_rejected_before_freezing(self):
        for field in ('model', 'profile'):
            with self.subTest(field=field), self.assertRaises(CpesError):
                writer.prepare_request(self.root / 'reading/reading.json', self.request, **{field: 'override'})
        self.assertFalse(self.request.exists())

    def test_accept_publishes_validated_files_keeps_actual_model_and_reuses(self):
        self.prepare_request()
        self.write_response()
        with patch.object(writer, 'CodexBackend') as backend:
            first = writer.accept(self.request, self.response, self.result, publish_final=True)
            second = writer.accept(self.request, self.response, self.result, publish_final=True)
        backend.assert_not_called()
        self.assertEqual(second['new_model_calls'], 0)
        self.assertTrue(second['reused'])
        self.assertEqual(Path(first['note']).read_text(), Path(second['note']).read_text())
        receipt = json.loads((self.result / 'receipt.json').read_text())
        self.assertEqual(receipt['model_key'], 'profile:qwen')
        self.assertEqual(receipt['usage']['input_tokens'], 31)
        self.assertEqual(receipt['timings']['generation_seconds'], 1.5)
        mapping = json.loads(Path(first['source_map']).read_text())
        self.assertEqual(mapping['paragraphs'][0]['source_ids'], ['B00001'])

    def test_new_draft_schema_omits_paragraph_explanation_and_publishes_provenance(self):
        self.prepare_request()
        request = writer.load_request(self.request)
        paragraph = request['schema']['properties']['sections']['items']['properties']['paragraphs']['items']
        self.assertNotIn('explanation', paragraph['properties'])
        self.assertNotIn('explanation', paragraph['required'])
        self.write_response()
        response = json.loads(self.response.read_text())
        draft = json.loads(response['output_text'])
        draft['sections'][0]['paragraphs'][0].pop('explanation', None)
        response['output_text'] = json.dumps(draft)
        self.response.write_text(json.dumps(response))
        raw = self.response.read_bytes()
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertIn('A probabilistic forecast.', Path(result['note']).read_text())
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual(mapping['paragraphs'][0]['source_ids'], ['B00001'])
        self.assertEqual(mapping['paragraphs'][0]['identity'], 'paper_summary')
        self.assertIsNone(mapping['paragraphs'][0]['explanation'])
        self.assertEqual(self.response.read_bytes(), raw)
        self.assertNotIn('explanation', json.loads((self.result / 'draft.json').read_text())['sections'][0]['paragraphs'][0])

    def test_unknown_source_is_not_published_and_failed_accept_is_not_retried(self):
        self.prepare_request()
        self.write_response(source='B99999')
        with self.assertRaisesRegex(ValueError, 'Unknown source'):
            writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertFalse((self.result / 'final').exists())
        with self.assertRaisesRegex(ValueError, 'automatic retry'):
            writer.accept(self.request, self.response, self.result, publish_final=True)

    def test_missing_actual_host_model_is_rejected_before_acceptance(self):
        self.prepare_request()
        self.response.write_text('{"output_text":"{}"}')
        with self.assertRaisesRegex(ValueError, 'model_key'):
            writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertFalse(self.result.exists())

    def test_accept_receipt_elapsed_time_includes_final_publication(self):
        self.prepare_request()
        self.write_response()
        clock = [10.0]
        publish = writer.publish

        def timed_publish(request, out):
            result = publish(request, out)
            clock[0] += 5.0
            return result

        with patch.object(writer.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(writer, 'publish', side_effect=timed_publish):
            result = writer.accept(self.request, self.response, self.result, publish_final=True)
        receipt = json.loads((self.result / 'receipt.json').read_text())
        self.assertEqual(receipt['elapsed_seconds'], 5.0)
        self.assertEqual(result['elapsed_seconds'], 5.0)

    def test_single_fenced_json_is_validated_and_published_with_raw_response_preserved(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        original_draft = json.loads(response['output_text'])
        response['output_text'] = '```json\n' + response['output_text'] + '\n```'
        self.response.write_text(json.dumps(response))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertTrue(Path(result['note']).exists())
        self.assertEqual(json.loads((self.result / 'response.json').read_text()), response)
        self.assertEqual(json.loads((self.result / 'draft.json').read_text()), original_draft)
        self.assertEqual(json.loads((self.result / 'receipt.json').read_text())['normalization'], 'single_json_fence')

    def test_interior_prose_quotes_and_lone_fence_preserve_words_with_audit(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        draft = json.loads(response['output_text'])
        prose = '读者标注了"集合预报"，并引用"first day of""validation set"。'
        draft['title'] = '关于"集合预报"的笔记'
        draft['sections'][0]['paragraphs'][0]['text'] = prose
        raw = '```json\n' + json.dumps(draft, ensure_ascii=False).replace('\\"', '"')
        response['output_text'] = raw
        self.response.write_text(json.dumps(response))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        saved = json.loads((self.result / 'draft.json').read_text())
        self.assertEqual(saved, draft)
        self.assertIn(prose, Path(result['note']).read_text())
        self.assertEqual(json.loads((self.result / 'response.json').read_text())['output_text'], raw)
        receipt = json.loads((self.result / 'receipt.json').read_text())
        self.assertGreater(receipt['normalization']['inserted_escape_count'], 0)
        self.assertEqual(result['normalization'], receipt['normalization'])

    def test_quote_normalization_rejects_ambiguous_boundaries_and_nonprose_fields(self):
        bad = ['{"text":"a" "identity":"mixed"}', '{"text":"a" "b","title":"c"}', '{"source_ids":["B"001"]}',
               '{"identity":"reader"thought"}', '{"text":"a "word", followed by prose"}',
               '{"text":"a", "title":"b"', '```json\n{"text":"a"}\n```\n```json\n{}\n```']
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                writer.normalize_draft_output(raw)

    def test_syntax_normalized_prose_still_rejects_unknown_sources_and_fields(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        for number, change in enumerate(('source', 'field')):
            draft = json.loads(response['output_text'])
            paragraph = draft['sections'][0]['paragraphs'][0]
            paragraph['text'] = 'The reader said "forecast" in a comment.'
            if change == 'source':
                paragraph['source_ids'] = ['B99999']
            else:
                paragraph['unexpected'] = 'not allowed'
            raw = '```json\n' + json.dumps(draft).replace('\\"', '"')
            self.response.write_text(json.dumps({**response, 'output_text': raw}))
            out = self.root / f'syntax-rejected-{number}'
            with self.assertRaises(ValueError):
                writer.accept(self.request, self.response, out, publish_final=True)
            self.assertFalse((out / 'final').exists())

    def test_plain_json_response_is_accepted_without_fence_normalization(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertEqual(json.loads((self.result / 'response.json').read_text()), response)
        self.assertNotIn('normalization', json.loads((self.result / 'receipt.json').read_text()))

    def test_fence_compatibility_never_accepts_prose_multiple_blocks_or_broken_json(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        fence = '```json\n' + response['output_text'] + '\n```'
        variants = [f'Here is the draft:\n{fence}', f'{fence}\nExplanation',
                    f'{fence}\n{fence}', '```json\n{"title":\n```']
        for number, text in enumerate(variants):
            with self.subTest(number=number):
                self.response.write_text(json.dumps({**response, 'output_text': text}))
                out = self.root / f'rejected-{number}'
                with self.assertRaises((ValueError, CpesError)):
                    writer.accept(self.request, self.response, out, publish_final=True)
                self.assertFalse((out / 'final').exists())

    def test_fenced_draft_still_requires_schema_fields_and_real_source_ids(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        for number, problem in enumerate(('schema', 'source')):
            draft = json.loads(response['output_text'])
            paragraph = draft['sections'][0]['paragraphs'][0]
            if problem == 'schema':
                del paragraph['identity']
            else:
                paragraph['source_ids'] = ['B99999']
            with self.subTest(problem=problem):
                self.response.write_text(json.dumps({**response, 'output_text': '```json\n' + json.dumps(draft) + '\n```'}))
                out = self.root / f'invalid-{number}'
                with self.assertRaisesRegex(ValueError, 'missing required fields' if problem == 'schema' else 'Unknown source'):
                    writer.accept(self.request, self.response, out, publish_final=True)
                self.assertFalse((out / 'final').exists())

    def test_frozen_schema_carries_paragraph_source_and_identity_contracts(self):
        self.prepare_request()
        schema = writer.load_request(self.request)['schema']
        paragraph = schema['properties']['sections']['items']['properties']['paragraphs']['items']
        self.assertTrue(paragraph['properties']['source_ids'].get('description'))
        self.assertTrue(paragraph['properties']['identity'].get('description'))

    def test_missing_omission_reasons_warn_without_blocking_publication(self):
        pdf = self.root / 'annotated.pdf'
        simple_pdf(pdf, annotations=True)
        reading = self.root / 'annotated-reading'
        prepare(pdf, reading)
        writer.prepare_request(reading / 'reading.json', self.request)
        available = [s['id'] for s in load_index(reading / 'reading.json')['catalog'] if s['record_ids']]
        self.write_response(available[0])
        original = json.loads(self.response.read_text())
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        mapping = json.loads(Path(result['source_map']).read_text())
        expected = available[1:]
        warning = next(w for w in result['warnings'] if w['code'] == 'unaccounted_reading_signals')
        self.assertEqual(warning['source_ids'], expected)
        self.assertEqual(mapping['validation']['warnings'], result['warnings'])
        self.assertEqual(mapping['omissions'], [])
        self.assertEqual(json.loads((self.result / 'response.json').read_text()), original)
        self.assertEqual(writer.accept(self.request, self.response, self.result, publish_final=True)['warnings'], result['warnings'])

    def test_paper_only_response_cannot_publish_when_reading_signals_were_supplied(self):
        pdf = self.root / 'annotated.pdf'
        simple_pdf(pdf, annotations=True)
        reading = self.root / 'annotated-reading'
        prepare(pdf, reading)
        writer.prepare_request(reading / 'reading.json', self.request, output_format='markdown')
        self.response.write_text(json.dumps({'output_text': '#### Note\n\nA paper summary [B001].', 'model_key': 'qwen'}))
        with self.assertRaisesRegex(ValueError, 'reading_signals_unreferenced'):
            writer.accept(self.request, self.response, self.result, publish_final=True)
        self.assertFalse((self.result / 'final').exists())

    def test_omission_bookkeeping_warns_but_unknown_sources_still_fail(self):
        self.prepare_request()
        self.write_response()
        response = json.loads(self.response.read_text())
        draft = json.loads(response['output_text'])
        draft['omissions'] = [{'source_id': 'B001', 'reason': ''},
                              {'source_id': 'B00001', 'reason': 'A redundant explanation.'}]
        self.response.write_text(json.dumps({**response, 'output_text': json.dumps(draft)}))
        result = writer.accept(self.request, self.response, self.result, publish_final=True)
        codes = {w['code'] for w in result['warnings']}
        self.assertTrue({'used_source_listed_as_omitted', 'duplicate_omission', 'omission_reason_missing'} <= codes)
        mapping = json.loads(Path(result['source_map']).read_text())
        self.assertEqual([row['reason'] for row in mapping['omissions']], ['', 'A redundant explanation.'])
        draft['omissions'] = [{'source_id': 'B99999', 'reason': 'Not present in the paper.'}]
        with self.assertRaisesRegex(ValueError, 'Unknown source'):
            writer.validate_draft(writer.load_request(self.request), {'output_text': json.dumps(draft)})

    def test_reader_thought_requires_explicit_comment_source_not_only_paper_context(self):
        pdf = self.root / 'annotated.pdf'
        simple_pdf(pdf, annotations=True)
        reading = self.root / 'annotated-reading'
        prepare(pdf, reading)
        request_path = self.root / 'annotated-request.json'
        writer.prepare_request(reading / 'reading.json', request_path)
        request = writer.load_request(request_path)
        index = load_index(reading / 'reading.json')
        comment = next(source for source in index['catalog'] if source['id'].startswith('A')
                       and resolve(index, source['id']).get('reader_source_quote'))
        comment_id = display_source_id(comment['id'])
        paper_id = display_source_id(next(source['id'] for source in index['catalog'] if source['kind'] == 'paper_text'))
        unused = [display_source_id(source['id']) for source in index['catalog']
                  if source['id'][0] in 'AN' and source['id'] != comment['id']]
        paragraph = {'text': resolve(index, comment['id'])['reader_source_quote'],
                     'source_ids': [paper_id], 'identity': 'reader_thought'}
        draft = {'title': 'Forecast', 'sections': [{'title': '', 'paragraphs': [paragraph]}],
                 'omissions': [{'source_id': source_id, 'reason': 'Not needed for this focused question.'}
                               for source_id in unused]}
        response = {'output_text': json.dumps(draft)}
        with self.assertRaisesRegex(ValueError, 'Reader thoughts require actual supplied reader words'):
            writer.validate_draft(request, response)
        paragraph['source_ids'].append(comment_id)
        accepted = writer.validate_draft(request, {'output_text': json.dumps(draft)})
        self.assertEqual(accepted['sections'][0]['paragraphs'][0]['source_ids'], [paper_id, comment_id])
        self.assertEqual(comment_id, f"A{int(comment['id'][1:]):03d}")


if __name__ == '__main__':
    unittest.main()
