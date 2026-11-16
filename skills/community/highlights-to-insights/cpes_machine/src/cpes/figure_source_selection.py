"""Explicit V32 candidate adapter. Prepares requests; never calls a model.

The wire contains IDs only. Derived cards contain source quotations, not
model paraphrases. The caller retains the unmodified provider response and
usage separately. This adapter does not activate a default reader release.
"""
import copy
import hashlib
import json
from pathlib import Path

from .figures import load_skill, validate_content

DEFAULT_REPO = Path(__file__).resolve().parents[2]
FIELDS = ('overview', 'how_to_read', 'author_findings', 'prerequisites', 'scope')


def value_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def configuration(repo, version='V32'):
    if version not in ('V32','V33'):
        raise ValueError('Unsupported source-selection candidate')
    path = Path(repo) / f'cpes-figure/versions/{version}.json'
    config = json.loads(path.read_text())
    rules_file=config.get('rules_file',f'{version}-model-instructions.md')
    if Path(rules_file).name!=rules_file:
        raise ValueError('Invalid candidate rules path')
    rules = (path.parent / rules_file).read_text()
    if (config['version'] != version or config['prefix'] != rules
            or hashlib.sha256(rules.encode()).hexdigest() != config['prefix_sha256']
            or value_hash(config['schema']) != config['schema_sha256']):
        raise ValueError('Source-selection candidate configuration changed')
    if 'request_schema' in config and value_hash(config['request_schema'])!=config['request_schema_sha256']:
        raise ValueError('Candidate request schema changed')
    return config


def source_path(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Source path outside run')
    return path


def prepare(job, source_root, *, model='qwen3.8-max', repo=DEFAULT_REPO, version='V32'):
    """Build real Responses API kwargs and a local frozen provenance binding.

    No SDK, credentials, network, retry or warmup is used. The request can be
    passed to an explicitly authorized API caller in a later experiment.
    """
    config = configuration(repo,version)
    skill = load_skill(repo)
    job = copy.deepcopy(job)
    job.update(reader_candidate=version, evidence_mode=config['evidence_mode'],
               wire_prefix=config['prefix'])
    root = Path(source_root).resolve()
    context = job['context']
    rows = [(job['card_template']['source']['tex_file'], context['figure_source'])]
    rows += [(m['file'], m['lines']) for m in context.get('numbered_mentions', [])]
    sources = {}
    for name, lines in rows:
        path = source_path(root, name)
        text = path.read_text().splitlines()
        for row in lines:
            n = row['line']
            if type(n) is not int or not 1 <= n <= len(text) or text[n-1] != row['text']:
                raise ValueError('Job text differs from frozen source lines')
        sources[name] = file_hash(path)
    catalog = skill.model_evidence_catalog(job)
    prompt = config['prefix'] + 'MODEL PACKET:\n' + skill.model_packet_text(job)
    images = {str(Path(p).resolve()): file_hash(p) for p in job['image_files']}
    if not images:
        raise ValueError('V32 interpretation requires a viewable figure')
    content = [{'type':'input_text', 'text':prompt}]
    content += [{'type':'input_image', 'image_url':skill.image_data_url(p)} for p in job['image_files']]
    request = {'model':model, 'input':[{'role':'user', 'content':content}],
               'text':{'format':{'type':'json_schema', 'name':'figure_card_content',
                                 'strict':True, 'schema':copy.deepcopy(config.get('request_schema',config['schema']))}},
               'reasoning':{'effort':'none'}, 'store':False}
    return {'reader_version':version, 'source_root':str(root), 'job':job,
            'catalog':catalog, 'api_request':request,
            'binding':{'job_sha256':value_hash(job), 'catalog_sha256':value_hash(catalog),
                       'prefix_sha256':config['prefix_sha256'], 'schema_sha256':config['schema_sha256'],
                       'request_schema_sha256':value_hash(request['text']['format']['schema']),
                       'source_files':sources, 'images':images}}


def assemble(raw, prepared, *, repo=DEFAULT_REPO):
    """Strict ID selection -> deterministic complete source quotes.

    Each ID becomes a separate finding. Never concatenate unrelated passages
    into a new author claim, discard invalid choices, or mutate raw output.
    This establishes textual provenance, not relevance/coverage or whole-card
    semantic correctness; those still need review.
    """
    config = configuration(repo,prepared['reader_version'])
    binding = prepared['binding']; job = prepared['job']; catalog = prepared['catalog']
    if (prepared['reader_version'] != config['version']
            or value_hash(job) != binding['job_sha256']
            or value_hash(catalog) != binding['catalog_sha256']
            or config['prefix_sha256'] != binding['prefix_sha256']
            or config['schema_sha256'] != binding['schema_sha256']
            or value_hash(config.get('request_schema',config['schema'])) != binding['request_schema_sha256']):
        raise ValueError('Prepared candidate binding changed')
    root = Path(prepared['source_root']).resolve()
    if any(file_hash(source_path(root, name)) != sha for name, sha in binding['source_files'].items()):
        raise ValueError('Source changed after preparation')
    if any(file_hash(p) != sha for p, sha in binding['images'].items()):
        raise ValueError('Image changed after preparation')
    if isinstance(raw, str):
        def unique_pairs(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate JSON key: ' + key)
                value[key] = item
            return value
        raw = json.loads(raw, object_pairs_hook=unique_pairs)
    validate_content(raw, config['schema'])
    findings = []; seen = set()
    for selection in raw['author_findings']:
        for eid in selection['evidence_ids']:
            if eid not in catalog or eid in seen:
                raise ValueError('Unknown or repeated complete evidence unit ID')
            seen.add(eid); unit = catalog[eid]
            if not unit['text'].strip() or not unit['evidence_spans']:
                raise ValueError('Empty source unit')
            findings.append({'claim':unit['text'], 'claim_origin':'source_quote',
                             'evidence_unit_ids':[eid], 'evidence':copy.deepcopy(unit['evidence_spans'])})
    card = copy.deepcopy(job['card_template'])
    card.pop('panels', None)
    for field in FIELDS:
        card[field] = findings if field == 'author_findings' else copy.deepcopy(raw[field])
    return card
