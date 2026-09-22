#!/usr/bin/env scholarseed-skill-python
"""Lossless field projections; this module never imports a model client."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
from writing_contract import digest
from generation_errors import GenerationError, diagnostic

PLACEHOLDERS = {'', 'n/a', 'na', 'none', 'null', 'not found', 'not available',
                'not provided', 'not specified', 'no information found',
                '未找到', '未找到信息', '暂无', '无相关信息', '未提及'}
OPTIONAL = {
    'card.method.novelty', 'common_fields.core_contribution', 'card.method.key_components',
    'common_fields.limitations', 'card.theorem_proof.proof_technique',
    'card.theorem_proof.key_assumptions', 'card.metrics.primary_metrics',
    'card.summary.key_themes', 'card.analysis.comparisons',
}
# Only operational metadata is excluded from the writing view. Unknown business
# fields inside card/common_fields are retained, including formulas and results.
OPERATIONAL = {'source_maps', 'source_map', 'provenance', 'processing_log',
               'request_log', 'cache_path', 'source_path', 'processing_status'}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(text, encoding='utf-8'); temporary.replace(path)


def clean(value):
    if isinstance(value, str):
        return None if value.strip().casefold().rstrip('.') in PLACEHOLDERS else value
    if isinstance(value, list):
        result, seen = [], set()
        for item in value:
            item = clean(item)
            if item is not None and digest(item) not in seen:
                result.append(item); seen.add(digest(item))
        return result or None
    if isinstance(value, dict):
        return {k: v for k, raw in value.items() if (v := clean(raw)) is not None} or None
    return value


def get(record, path):
    for part in path.split('.'):
        if not isinstance(record, dict): return None
        record = record.get(part)
    return clean(record)


def survey_sections(value):
    if not isinstance(value, list): return None
    out = []
    for node in value:
        if isinstance(node, str): out.append(node); continue
        if not isinstance(node, dict): continue
        out.append({k: survey_sections(v) if k == 'subsections' else v
                    for k, v in node.items() if k in ('title', 'description', 'subsections')})
    return clean(out)


def project(record, extra=()):
    fields, mapping, seen = {}, {}, set()
    def add(label, paths, transform=lambda v: v):
        for path in paths:
            value = clean(transform(get(record, path)))
            if value is not None:
                if digest(value) not in seen:
                    fields[label] = value; mapping[label] = path; seen.add(digest(value))
                return True
        return False
    has_tldr = add('TLDR', ['common_fields.tldr', 'card.idea', 'common_fields.core_contribution'])
    if not has_tldr: add('Question', ['common_fields.research_question', 'card.problem'])
    kind = record.get('paper_type')
    if kind == 'method':
        add('Method', ['card.method.name']); add('Mechanism', ['card.method.description'])
    elif kind == 'survey':
        add('Scope', ['card.summary.scope']); add('Taxonomy', ['card.summary.taxonomy'])
        if not add('Survey outline', ['card.survey_outline.sections'], survey_sections):
            legacy = get(record, 'survey_outline_skeletons')
            if legacy:
                def legacy_sections(value):
                    if not isinstance(value, list): value = [value]
                    return [survey_sections(v.get('sections')) if isinstance(v, dict) else v for v in value]
                add('Legacy survey outline', ['survey_outline_skeletons'], legacy_sections)
            else: add('Themes (no extracted outline)', ['card.summary.key_themes'])
    elif kind == 'benchmark':
        add('Benchmark', ['card.dataset.name']); add('Design', ['card.dataset.description'])
        add('Protocol', ['card.metrics.evaluation_protocol'])
    elif kind == 'theory':
        add('Impact', ['card.implication.theoretical_impact']); add('Connections', ['card.implication.connections'])
    else:
        add('Contribution', ['common_fields.core_contribution'])
    if not fields: add('Abstract (fallback)', ['abstract'])
    for path in extra:
        paths = [path, 'card.discussion.limitations'] if path == 'common_fields.limitations' else [path]
        add(path, paths)
    return fields, mapping


def writing_content(record):
    def strip(value):
        if isinstance(value, dict): return {k: strip(v) for k, v in value.items() if k not in OPERATIONAL}
        if isinstance(value, list): return [strip(v) for v in value]
        return value
    return {k: strip(record[k]) for k in ('abstract', 'common_fields', 'card', 'survey_outline_skeletons') if k in record}


def build(ws, view, options=None):
    started = time.monotonic(); ws = Path(ws)
    from paper_materials import require_ready
    require_ready(ws)
    options = options or {}
    if set(options) - {'extra_fields', 'max_input_bytes'}:
        raise GenerationError('SCHEMA_INVALID', 'unknown evidence view options')
    extra = options.get('extra_fields', [])
    if not isinstance(extra, list) or any(not isinstance(p, str) or p not in OPTIONAL for p in extra):
        raise GenerationError('SCHEMA_INVALID', 'extra_fields must use the documented whitelist')
    cards, keys = read(ws/'03_process/paper_cards.json'), read(ws/'03_process/cite_keys.json')
    if not isinstance(cards, dict) or not cards or not isinstance(keys, dict):
        raise GenerationError('SCHEMA_INVALID', 'cards and citation index must be nonempty objects')
    selected_path = ws/'02_retrieval/selected_paper.json'
    selected = None
    if selected_path.exists():
        selected = read(selected_path)
        if not isinstance(selected, dict):
            raise GenerationError('SCHEMA_INVALID', 'selected_paper must be an object')
        missing = sorted(set(selected)-set(cards))
        if missing:
            raise GenerationError('INPUT_MISSING', 'selected papers lack cards; complete processing before generation',
                                  str(selected_path), paper_ids=missing)
    cards = {pid:cards[pid] for pid in selected}
    keys = {pid:keys[pid] for pid in selected}
    if any(not isinstance(k, str) or not k or any(c in k for c in '{} ,\\\n') for k in keys.values()):
        raise GenerationError('SCHEMA_INVALID', 'citation keys must be nonempty safe identities')
    if len(set(keys.values())) != len(keys): raise GenerationError('DUPLICATE_ID', 'duplicate citation key')
    papers, index, lines = [], {}, []
    for pid, record in cards.items():
        if pid not in keys: raise GenerationError('UNKNOWN_CITE_KEY', 'paper has no citation identity', pid)
        if not isinstance(record, dict): raise GenerationError('SCHEMA_INVALID', 'card must be an object', pid)
        if record.get('paperId') not in (None, '', pid):
            raise GenerationError('DUPLICATE_ID', 'record paperId differs from dictionary identity', pid)
        head = {'paper_id': pid, 'cite_key': keys[pid], 'title': record.get('title') or 'Unknown title',
                'year': record.get('year') or 'unknown', 'paper_type': record.get('paper_type') or 'unknown',
                'reading_depth': record.get('reading_depth') or 'unknown'}
        fields, mapping = project(record, extra) if view == 'outline' else (writing_content(record), {})
        papers.append({**head, 'fields': fields, 'field_mapping': mapping})
        index[pid] = {**head, 'field_mapping': mapping,
                      'source_pointer': f'03_process/paper_cards.json#/{pid}'}
        lines += [f"## [{keys[pid]}] {head['title']}",
                  f"ID: {pid}; Type: {head['paper_type']}; Year: {head['year']}; Evidence: {head['reading_depth']}"]
        for label, value in fields.items():
            lines.append(f'{label}: ' + (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)))
        lines.append('')
    text = '\n'.join(lines); size = len(text.encode('utf-8'))
    limit = options.get('max_input_bytes')
    if limit is not None and (type(limit) is not int or limit < 1):
        raise GenerationError('SCHEMA_INVALID', 'max_input_bytes must be positive')
    if limit is not None and size > limit:
        raise GenerationError('INPUT_TOO_LARGE', 'evidence exceeds configured byte capacity; nothing truncated', bytes=size, limit=limit)
    folder = ws / ('04_outline/_internal' if view == 'outline' else '05_generation/_internal')
    manifest = {'view': view, 'papers': papers, 'extra_fields': extra, 'bytes': size,
                'options': options}
    save(folder/f'{view}_evidence.json', manifest); save(folder/f'{view}_evidence.md', text)
    save(ws/'05_generation/_internal/evidence_index.json', {'papers': index,
         'provenance_paths': [rel for rel in ('03_process/source_maps.json', '02_retrieval/paper_info.json') if (ws/rel).exists()]})
    return {'status': 'SUCCESS', 'view': view, 'papers': len(papers), 'bytes': size,
            'model_calls': 0, 'elapsed_sec': round(time.monotonic()-started, 3),
            'artifacts': [str(folder/f'{view}_evidence.{ext}') for ext in ('json', 'md')],
            'extra_fields': extra}


def ensure(ws, view):
    """Build complete evidence from current cards; no content-addressed cache."""
    folder=ws/('04_outline/_internal' if view=='outline' else '05_generation/_internal')
    path=folder/f'{view}_evidence.json'
    options=read(path).get('options',{}) if path.exists() else {}
    return build(ws,view,options)


def main():
    p = argparse.ArgumentParser(); p.add_argument('action', choices=['build'])
    p.add_argument('--workspace', required=True); p.add_argument('--view', choices=['outline', 'writing'], required=True)
    p.add_argument('--request'); args = p.parse_args()
    try: result = build(Path(args.workspace), args.view, read(args.request) if args.request else None)
    except (ValueError, OSError, TypeError, KeyError) as exc: result = diagnostic(exc)
    print(json.dumps(result, ensure_ascii=False)); return int(result['status'] == 'FAILED')


if __name__ == '__main__': sys.exit(main())
