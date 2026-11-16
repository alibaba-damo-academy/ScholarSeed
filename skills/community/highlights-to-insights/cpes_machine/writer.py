"""Frozen HINT writing requests, explicit isolated execution and small receipts.

The existing CPES backend/usage parser are reused. Preparation and response
acceptance are offline; only execute() starts a model, once per output directory.
"""
import json
from hashlib import sha256
from pathlib import Path
import re
import sys
import tempfile
import time

from . import ROOT, VERSION
from .draft_stream import DraftPreview
from .host import in_host, validate_options
from .stream_backend import StreamingBackend
from .syntax import escape_prose_quotes
from .markdown import CONTRACT as MARKDOWN_CONTRACT, MARKER_START, MARKER_END, ALTERNATIVE_MARKER_STARTS, MarkdownPreview, parse_markdown
from cpes.backends import CodexBackend
from cpes.contracts import CpesError
from cpes.usage import usage_summary

sys.path.insert(0, str(ROOT.parent / 'scripts'))
from reading_pipeline import assemble, load_index, read_json, resolve, value_hash
from packet_selection import section_sources
from pdf_sources import fingerprint
from source_ids import display_source_id


def obj(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


def array(items):
    return {'type': 'array', 'items': items}


TEXT = {'type': 'string'}
DRAFT_SCHEMA = obj({'title': TEXT, 'sections': array(obj({'title': {
    'type': 'string', 'description': 'Use an empty string for the opening section, then nonempty headings for subsequent sections.'}, 'paragraphs': array(obj({
    'text': {**TEXT, 'description': 'Finished note paragraph in the requested output language.'}, 'source_ids': {**array(TEXT), 'description':
        'List the actual distinct source IDs supporting this paragraph, exactly as displayed in the packet '
        '(for example A004, B011, N001). When quoting or paraphrasing reader comments or independent notes, '
        'include their actual A/N IDs here, even when their words already appear in text. B IDs support paper '
        'context and cannot replace the reader-word sources. A reader_thought paragraph must include at least '
        'one source containing actual supplied reader words; a highlight without a comment is insufficient.'},
    'identity': {'type': 'string', 'enum': ['paper_summary', 'mixed', 'reader_thought', 'model_explanation', 'model_suggestion'],
        'description': 'paper_summary: paper-based claims. model_explanation: explanatory synthesis, '
        'including direct answers to learning questions. A marked term or question guides focus and '
        'does not require a reader_thought paragraph. reader_thought: faithfully retained substantive '
        'personal ideas from supplied comments or notes, linked to their actual A/N sources. '
        'mixed: combined ownership, retaining the actual personal-idea sources. model_suggestion: '
        'a model-proposed suggestion. Preserve uncertainty and never invent reader views.'}}))})), 'omissions': array(obj({'source_id': TEXT, 'reason': TEXT}))})


def code_hashes():
    return {name: fingerprint(ROOT / name) for name in
            ('writer.py', 'host.py', 'draft_stream.py', 'stream_backend.py', 'syntax.py', 'markdown.py', '__init__.py', 'src/cpes/backends.py', 'src/cpes/contracts.py', 'src/cpes/usage.py', 'src/cpes/figures.py', '../references/writing-guide.md')}


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def update_receipt(path, value):
    # Only this invocation owns the exclusively created directory.
    tmp = path.with_suffix('.tmp')
    save(tmp, value)
    tmp.replace(path)


def prepare_request(index_path, output, images=(), model=None, profile=None, sources=(), sections=(), language=None, requirements='', output_format='json_schema'):
    validate_options(model, profile)
    if output_format not in ('json_schema', 'markdown'):
        raise ValueError('Unknown writing output format.')
    if not isinstance(requirements, str):
        raise ValueError('Writing requirements must be a string.')
    requirements = requirements.strip()
    if language is not None:
        if not isinstance(language, str) or not language.strip():
            raise ValueError('Output language must be a nonempty string.')
        language = language.strip()
    index_path = Path(index_path).expanduser().resolve()
    index = load_index(index_path)
    selected = list(dict.fromkeys(Path(p).expanduser().resolve() for p in images))
    image_refs = [{'path': str(p), 'sha256': fingerprint(p)} for p in selected]
    guide = (ROOT.parent / 'references' / 'writing-guide.md').read_text(encoding='utf-8')
    packet = (index_path.parent / 'packet.md').read_text(encoding='utf-8')
    prompt = guide.rstrip() + '\n\n# Reading materials\n\n' + packet
    if output_format == 'markdown':
        prompt = MARKDOWN_CONTRACT + '\n\n' + prompt
    else:
        prompt = ('Return the finished note in the supplied JSON schema, not Markdown transport references. '
                  'Put the two bibliographic lines in sections[0].paragraphs[0].text; '
                  'keep sections[0].title empty.\n\n' + prompt)
    if requirements:
        prompt = ('User-specified writing requirements (override writing defaults):\n'
                  + requirements + '\n\n' + prompt)
    if language is not None:
        prompt = (f'Output language: {json.dumps(language, ensure_ascii=False)}. '
                  'Use this language for the note title, headings and prose; retain original terms where useful. '
                  'The language of evidence does not override this choice.\n\n' + prompt)
    initial = set(index['packet_selection']['source_ids'])
    extra = []
    for sid in dict.fromkeys([*sources, *section_sources(index, sections)]):
        source = resolve(index, sid)
        if source['kind'] != 'paper_text':
            raise ValueError('Additional sources must be paper B IDs; reading signals are already included.')
        sid = source['id']
        if sid not in initial and sid not in extra:
            extra.append(sid)
            prompt += f"\n### {display_source_id(sid)} · physical page {source['page']} · explicitly retrieved original\n{source['text']}\n"
    request = {'version': VERSION, 'index': str(index_path), 'index_fingerprint': index['fingerprint'],
               'prompt': prompt, 'schema': DRAFT_SCHEMA, 'images': image_refs, 'model': model, 'profile': profile,
               'additional_source_ids': extra,
               'code_hashes': code_hashes()}
    if language is not None:
        request['language'] = language
    if requirements:
        request['writing_requirements'] = requirements
    if output_format == 'markdown':
        request.pop('schema')
        request['output_format'] = 'markdown'
    if in_host():
        request['preview'] = ({'format': 'markdown', 'hidden_marker': {
            'start': MARKER_START, 'end': MARKER_END,
            'alternative_starts': list(ALTERNATIVE_MARKER_STARTS)}}
            if output_format == 'markdown' else {'format': 'markdown_fields', 'fields': [
            {'path': ['title'], 'kind': 'heading1'},
            {'path': ['sections', '*', 'title'], 'kind': 'heading2'},
            {'path': ['sections', '*', 'paragraphs', '*', 'text'], 'kind': 'paragraph'}]})
    request['fingerprint'] = value_hash(request)
    request_path = Path(output).expanduser().resolve()
    save(request_path, request)
    result = {'ok': True, 'request': str(request_path), 'prompt_characters': len(prompt),
              'images': len(image_refs), 'model_calls': 0}
    if in_host():
        response_path = request_path.with_name(request_path.stem + '-response.json')
        result['generation'] = {'capability': 'generation', 'operation': 'run', 'request': {
            'request_id': request['fingerprint'], 'input_path': str(request_path), 'output_path': str(response_path)}}
        result['accept'] = {'request': str(request_path), 'response': str(response_path),
                            'out_dir': str(request_path.parent / 'writing'), 'publish': True}
    return result


def load_request(path):
    request = read_json(path)
    if request.get('version') != VERSION or value_hash({k: v for k, v in request.items() if k != 'fingerprint'}) != request.get('fingerprint'):
        raise ValueError('Writing request changed.')
    if request['code_hashes'] != code_hashes():
        raise ValueError('Writer code changed; prepare a new request.')
    index = load_index(request['index'])
    if index['fingerprint'] != request['index_fingerprint']:
        raise ValueError('Reading preparation changed.')
    for image in request['images']:
        if fingerprint(image['path']) != image['sha256']:
            raise ValueError('Selected image changed.')
    return request


def normalize_draft_output(output):
    if not isinstance(output, str):
        raise ValueError('Response needs an output_text string containing draft JSON.')
    content = output
    operation = None
    fenced = re.fullmatch(r'\s*```json[ \t]*\r?\n(?P<content>.*?)\r?\n```[ \t]*\s*', output, re.DOTALL)
    if fenced is not None:
        content = fenced.group('content')
        operation = 'single_json_fence'
    else:
        opening = re.match(r'\s*```json[ \t]*\r?\n', output)
        if opening is not None:
            content = output[opening.end():]
            operation = 'opening_json_fence'
    if operation is not None and '```' in content:
        raise ValueError('Response must contain only one JSON code block.')
    edits = []
    try:
        json.loads(content)
    except json.JSONDecodeError:
        content, edits = escape_prose_quotes(content)
    if edits or operation == 'opening_json_fence':
        return content, {
            'kind': 'syntax_only', 'fence': operation,
            'inserted_escape_count': len(edits), 'insertions': edits,
            'input_text_sha256': sha256(output.encode('utf-8')).hexdigest(),
            'normalized_text_sha256': sha256(content.encode('utf-8')).hexdigest(),
        }
    return content, operation


def validate_draft(request, response):
    if request.get('output_format') == 'markdown':
        output = json.dumps(parse_markdown(response.get('output_text')), ensure_ascii=False)
    else:
        output, _ = normalize_draft_output(response.get('output_text'))
    # Use the final assembler's real source/ownership/omission checks. Temporary
    # products are removed immediately, not retained as another evidence export.
    with tempfile.TemporaryDirectory(prefix='hint-draft-check-') as tmp:
        path = Path(tmp) / 'draft.json'
        path.write_text(output, encoding='utf-8')
        draft = read_json(path)
        from cpes.figures import validate_content
        validate_content(draft, request.get('schema', DRAFT_SCHEMA))
        accepted = assemble(request['index'], path, Path(tmp) / 'final')
        mapping = read_json(accepted['source_map'])
        if mapping['records'] and not any(entry['record_ids'] for entry in mapping['entries']):
            raise ValueError('reading_signals_unreferenced: cite actual supplied A/N reading signals; '
                             'paper B sources alone cannot form a personalized note.')
    return draft


def reuse(request, out, origin, preserve_text=False):
    if not out.exists():
        return None
    receipt = read_json(out / 'receipt.json')
    if receipt['request_fingerprint'] != request['fingerprint'] or receipt['origin'] != origin:
        raise ValueError('Existing result belongs to another request or response.')
    text_only = receipt['status'] == 'text_preserved' and preserve_text
    if receipt['status'] != 'completed' and not text_only:
        raise ValueError('Previous dispatch is failed or uncertain; automatic retry is refused.')
    names = set(receipt.get('files', {}))
    if (text_only and names != {'response.json', 'note.raw.md'}) or (not text_only and names - {'note.raw.md'} not in (
            {'response.json', 'draft.json'}, {'response.json', 'draft.json', 'final/note.md', 'final/source-map.json'})):
        raise ValueError('Completed receipt is missing required file bindings.')
    for name, expected in receipt['files'].items():
        if fingerprint(out / name) != expected:
            raise ValueError('Completed result changed.')
    return {'ok': True, 'reused': True, 'new_model_calls': 0, 'usage': receipt['usage'],
            'receipt': str(out / 'receipt.json'),
            **({'raw_note': str(out / 'note.raw.md')} if 'note.raw.md' in names else {}),
            **({'provenance_status': 'unverified', 'warnings': receipt['warnings']} if text_only
               else {'draft': str(out / 'draft.json')})}


def begin(request, out, origin):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir()  # Exclusive claim: a second process cannot dispatch the same run.
    receipt = {'version': VERSION, 'request_fingerprint': request['fingerprint'], 'origin': origin,
               'status': 'started', 'usage': None, 'elapsed_seconds': None,
               'model_calls': None, 'files': {}, 'semantic_quality': 'not_evaluated'}
    save(out / 'receipt.json', receipt)
    return receipt


def finish(request, out, receipt, response, started, calls, preserve_text=False):
    save(out / 'response.json', response)
    receipt['usage'] = usage_summary(response.get('usage'))
    receipt['model_calls'] = calls
    if response.get('model_key') is not None:
        receipt['model_key'] = response['model_key']
        receipt['host_elapsed_seconds'] = response.get('elapsed_seconds')
        receipt['timings'] = response.get('timings')
    normalization = None
    if request.get('output_format') != 'markdown':
        _, normalization = normalize_draft_output(response.get('output_text'))
    if normalization is not None:
        receipt['normalization'] = normalization
    if preserve_text:
        load_request_data_check(request)
        (out / 'note.raw.md').write_text(response['output_text'], encoding='utf-8')
    try:
        draft = validate_draft(request, response)
    except ValueError as error:
        if not preserve_text:
            raise
        load_request_data_check(request)
        receipt.update(status='text_preserved', warnings=[str(error)],
                       elapsed_seconds=time.monotonic() - started,
                       files={name: fingerprint(out / name) for name in ('response.json', 'note.raw.md')})
        update_receipt(out / 'receipt.json', receipt)
        return {'ok': True, 'reused': False, 'new_model_calls': calls, 'usage': receipt['usage'],
                'raw_note': str(out / 'note.raw.md'), 'receipt': str(out / 'receipt.json'),
                'provenance_status': 'unverified', 'warnings': receipt['warnings']}
    load_request_data_check(request)
    save(out / 'draft.json', draft)
    receipt.update(status='completed', elapsed_seconds=time.monotonic() - started,
                   files={name: fingerprint(out / name) for name in
                          (('response.json', 'draft.json', 'note.raw.md') if preserve_text else ('response.json', 'draft.json'))})
    update_receipt(out / 'receipt.json', receipt)
    return {'ok': True, 'reused': False, 'new_model_calls': calls, 'usage': receipt['usage'],
            'elapsed_seconds': receipt['elapsed_seconds'], 'draft': str(out / 'draft.json'), 'receipt': str(out / 'receipt.json'),
            **({'normalization': receipt['normalization']} if 'normalization' in receipt else {}),
            **({'raw_note': str(out / 'note.raw.md')} if preserve_text else {})}


def load_request_data_check(request):
    index = load_index(request['index'])
    if index['fingerprint'] != request['index_fingerprint']:
        raise ValueError('Reading preparation changed during generation.')
    if request['code_hashes'] != code_hashes():
        raise ValueError('Writer code changed during generation.')
    for image in request['images']:
        if fingerprint(image['path']) != image['sha256']:
            raise ValueError('Selected image changed during generation.')


def failure(out, receipt, exc, started):
    details = getattr(exc, 'details', {})
    if isinstance(details, dict) and details.get('usage') is not None:
        receipt['usage'] = usage_summary(details['usage'])
    receipt.update(status='failed', error_type=type(exc).__name__, error_code=getattr(exc, 'code', None),
                   elapsed_seconds=time.monotonic() - started)
    update_receipt(out / 'receipt.json', receipt)


def publish(request, out):
    """Publish both assembled files together, then bind them to the receipt."""
    receipt = read_json(out / 'receipt.json')
    if 'final/note.md' not in receipt['files']:
        if (out / 'final').exists():
            raise ValueError('Unbound final output already exists.')
        with tempfile.TemporaryDirectory(prefix='assemble-', dir=out) as tmp:
            stage = Path(tmp) / 'final'
            assemble(request['index'], out / 'draft.json', stage)
            stage.rename(out / 'final')
        receipt['files'].update({name: fingerprint(out / name) for name in ('final/note.md', 'final/source-map.json')})
        update_receipt(out / 'receipt.json', receipt)
    mapping = read_json(out / 'final/source-map.json')
    return {'note': str(out / 'final/note.md'), 'source_map': str(out / 'final/source-map.json'),
            'warnings': mapping.get('validation', {}).get('warnings', [])}


def execute(request_path, output, timeout=300, on_text=None):
    if in_host():
        raise CpesError('host_controlled_generation_required',
                        'Inside ScholarSeed, use writing.py request, forward its generation payload to the controlled '
                        'scholarseed_bridge tool, then writing.py accept --publish. Shell generation is unavailable.')
    request = load_request(request_path)
    out = Path(output).expanduser().resolve()
    origin = {'backend': 'codex', 'model': request['model'], 'profile': request['profile']}
    existing = reuse(request, out, origin)
    if existing:
        if on_text is not None:
            existing.update(publish(request, out))
            if request.get('output_format') == 'markdown':
                MarkdownPreview(on_text).feed(read_json(out / 'response.json')['output_text'])
            else:
                DraftPreview(on_text).feed((out / 'draft.json').read_text(encoding='utf-8'))
        return existing
    receipt = begin(request, out, origin)
    started = time.monotonic()
    try:
        if on_text is not None:
            response = StreamingBackend(model=request['model'], profile=request['profile'], timeout=timeout).generate(
                request['prompt'], request.get('schema'), [i['path'] for i in request['images']],
                (MarkdownPreview(on_text) if request.get('output_format') == 'markdown' else DraftPreview(on_text)).feed)
        else:
            if request.get('output_format') == 'markdown':
                raise CpesError('markdown_requires_stream', 'Plain Markdown writing uses --stream; no model was called.')
            response = CodexBackend(model=request['model'], profile=request['profile'], timeout=timeout, debug=False).generate(
                request['prompt'], request['schema'], [i['path'] for i in request['images']], out)
        result = finish(request, out, receipt, response, started, 1)
        if on_text is not None:
            result.update(publish(request, out))
        return result
    except BaseException as exc:
        failure(out, receipt, exc, started)
        raise


def accept(request_path, response_path, output, publish_final=False, preserve_text=False):
    started = time.monotonic()
    request = load_request(request_path)
    validate_options(request.get('model'), request.get('profile'))
    response_path = Path(response_path).expanduser().resolve()
    response = read_json(response_path)
    if response.get('status') not in (None, 'completed'):
        raise ValueError('External response is incomplete.')
    if in_host() and not (isinstance(response.get('model_key'), str) and response['model_key']):
        raise ValueError('Client response needs the actual model_key.')
    if preserve_text:
        if request.get('output_format') != 'markdown' or not isinstance(response.get('output_text'), str) or not response['output_text'].strip():
            raise ValueError('Text preservation requires a completed nonempty Markdown response.')
        load_request_data_check(request)
    origin = {'backend': 'external', 'response_sha256': fingerprint(response_path)}
    out = Path(output).expanduser().resolve()
    existing = reuse(request, out, origin, preserve_text=preserve_text)
    if existing:
        if preserve_text and 'raw_note' not in existing:
            with (out / 'note.raw.md').open('x', encoding='utf-8') as stream:
                stream.write(response['output_text'])
            completed_receipt = read_json(out / 'receipt.json')
            completed_receipt['files']['note.raw.md'] = fingerprint(out / 'note.raw.md')
            update_receipt(out / 'receipt.json', completed_receipt)
            existing['raw_note'] = str(out / 'note.raw.md')
        if publish_final and existing.get('provenance_status') != 'unverified':
            existing.update(publish(request, out))
        return existing
    receipt = begin(request, out, origin)
    try:
        result = finish(request, out, receipt, response, started, 0, preserve_text=preserve_text)
        if publish_final and result.get('provenance_status') != 'unverified':
            result.update(publish(request, out))
            completed_receipt = read_json(out / 'receipt.json')
            completed_receipt['elapsed_seconds'] = time.monotonic() - started
            update_receipt(out / 'receipt.json', completed_receipt)
            result['elapsed_seconds'] = completed_receipt['elapsed_seconds']
        return result
    except Exception as exc:
        failure(out, receipt, exc, started)
        raise
